import "server-only";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

/**
 * 声纹：只认他的声音。全在本机算——sherpa-onnx + 3D-Speaker 的 CAM++ 中文声纹模型（28MB，第一次用时下载）。
 * 录入：他随便说几秒，切成几段各算一个声纹向量，取平均存 data/voiceprint.json。
 * 比对：一段 16k PCM 算出向量，和存的那个算余弦相似度，过线就是他。
 * 实测：同一个人 0.85 以上，不同人 0.3～0.7；线默认 0.45（见下），日志里会打分，不准可以用 DONGNI_VOICEPRINT_MIN 调。
 */
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(process.cwd(), "data");
const MODEL = path.join(DATA_DIR, "models", "campplus.onnx");
const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";
const FILE = path.join(DATA_DIR, "voiceprint.json");
/**
 * 判「是他」的线。原来 0.55，实测他自己的正常一句话经常落在 0.42~0.53（见 logs/server.log：
 * 「生图的停掉」0.32、「挂电话的功能不能并发吗」0.42、「报告一下进度」0.53 都被当成别人吞掉，
 * 而他重复一遍就能过线）——真杂音（电视、旁人）稳定在 0.05~0.19，两层根本不重叠。
 * 所以线降到 0.45，再留一个 0.30~0.45 的「听着像你」中间带：照常回答，只是字幕上标一下。
 */
export const VOICEPRINT_MIN = Number(process.env.DONGNI_VOICEPRINT_MIN) || 0.45;
/** 中间带下界：到这就算「大概是他」，认下来别装聋 */
export const VOICEPRINT_MAYBE = Number(process.env.DONGNI_VOICEPRINT_MAYBE) || 0.3;
/** 录入要说够这么久（秒） */
export const ENROLL_SECONDS = 8;

type Stream = { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void };
type Extractor = { createStream(): Stream; compute(s: Stream): Float32Array };

const g = globalThis as unknown as { __dongniVp?: Extractor; __dongniVpPrint?: number[] | null; __dongniVpLoading?: Promise<Extractor> };

async function extractor(): Promise<Extractor> {
  if (g.__dongniVp) return g.__dongniVp;
  g.__dongniVpLoading ??= (async () => {
    if (!fs.existsSync(MODEL)) {
      console.log("[dongni] 声纹模型第一次用，下载中…");
      const res = await fetch(MODEL_URL);
      if (!res.ok) throw new Error(`声纹模型下载失败（HTTP ${res.status}）`);
      fs.mkdirSync(path.dirname(MODEL), { recursive: true });
      fs.writeFileSync(MODEL + ".part", Buffer.from(await res.arrayBuffer()));
      fs.renameSync(MODEL + ".part", MODEL);
    }
    // 原生模块：next.config 里列为外部包，不进打包
    const mod = await import("sherpa-onnx-node");
    const sherpa = mod.default ?? mod;
    g.__dongniVp = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 1, debug: 0 }) as Extractor;
    return g.__dongniVp;
  })().finally(() => (g.__dongniVpLoading = undefined));
  return g.__dongniVpLoading;
}

const toFloat = (pcm: Buffer) => {
  const n = pcm.length >> 1;
  const i16 = pcm.byteOffset % 2 ? new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + n * 2)) : new Int16Array(pcm.buffer, pcm.byteOffset, n);
  return Float32Array.from(i16, (v) => v / 32768);
};

const norm = (v: ArrayLike<number>) => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
};

const normF = (v: ArrayLike<number>) => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
};

/* ---------------- 算声纹放到单独的线程上 ----------------
 * 这个模型是同步的原生计算，跑在主线程上就是「整台机器停一下」：打电话时这几十毫秒里
 * 麦克风的声音送不出去、她的声音也回不来，声音就一顿一顿、句子被切碎——两个月前一直
 * 在别处找原因，其实它在通话的关键路径上。放到 worker 线程：算的时候主线程照常收发音。
 * 线程起不来（原生模块不支持、路径不对）就老实退回主线程算，功能不受影响，只是慢一点。
 */
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { join } = require("node:path");
let sherpa = null;
try {
  sherpa = require("sherpa-onnx-node");
} catch (e) {
  try {
    sherpa = require(join(process.cwd(), "node_modules", "sherpa-onnx-node"));
  } catch (e2) {
    parentPort.postMessage({ type: "fatal", message: String((e && e.message) || e) });
  }
}
let ex = null;
if (sherpa) {
  try {
    const s = sherpa.default ?? sherpa;
    ex = new s.SpeakerEmbeddingExtractor({ model: workerData.model, numThreads: 1, debug: 0 });
    parentPort.postMessage({ type: "ready" });
  } catch (e) {
    parentPort.postMessage({ type: "fatal", message: String((e && e.message) || e) });
    sherpa = null;
  }
}
parentPort.on("message", (msg) => {
  if (!ex || !msg || msg.type !== "embed") return;
  try {
    const stream = ex.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(msg.samples) });
    stream.inputFinished();
    parentPort.postMessage({ type: "result", id: msg.id, embedding: Array.from(ex.compute(stream)) });
  } catch (e) {
    parentPort.postMessage({ type: "result", id: msg.id, error: String((e && e.message) || e) });
  }
});
`;

type Reply =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "result"; id: number; embedding?: number[]; error?: string };

type Thread = {
  worker: Worker;
  ready: Promise<boolean>;
  seq: number;
  dead: boolean;
  waiting: Map<number, { ok: (v: Float32Array) => void; timer: NodeJS.Timeout }>;
};

const gt = globalThis as unknown as { __dongniVpThread?: Thread | null };

function thread(): Thread | null {
  if (gt.__dongniVpThread !== undefined) return gt.__dongniVpThread;
  try {
    const worker = new Worker(WORKER_SRC, { eval: true, workerData: { model: MODEL } });
    let settle: (ok: boolean) => void = () => {};
    const t: Thread = { worker, ready: new Promise<boolean>((ok) => (settle = ok)), seq: 0, dead: false, waiting: new Map() };
    const die = (why: string) => {
      if (t.dead) return;
      t.dead = true;
      console.warn(`[dongni] 声纹线程没起来，退回主线程算：${why}`);
      gt.__dongniVpThread = null;
      settle(false);
      for (const [, p] of t.waiting) {
        clearTimeout(p.timer);
        p.ok(new Float32Array(0));
      }
      t.waiting.clear();
      try {
        void worker.terminate();
      } catch {}
    };
    worker.on("message", (m: Reply) => {
      if (m.type === "ready") return settle(true);
      if (m.type === "fatal") return die(m.message);
      const p = t.waiting.get(m.id);
      if (!p) return;
      t.waiting.delete(m.id);
      clearTimeout(p.timer);
      p.ok(m.embedding ? Float32Array.from(m.embedding) : new Float32Array(0));
    });
    worker.on("error", (e) => die(e instanceof Error ? e.message : String(e)));
    // 不管怎么收场，下去的那个就不再用（下次再起一个）
    worker.on("exit", (code) => die(`线程退出了（${code}）`));
    // 这个小线程不该把进程吊着不退出
    worker.unref();
    gt.__dongniVpThread = t;
    return t;
  } catch (e) {
    console.warn(`[dongni] 声纹线程开不了，在主线程算：${e instanceof Error ? e.message : e}`);
    gt.__dongniVpThread = null;
    return null;
  }
}

/** 在线程上算；线程不可用/超时就返回 null（调用方退回主线程） */
async function embedOnThread(samples: Float32Array): Promise<Float32Array | null> {
  const t = thread();
  if (!t || t.dead) return null;
  if (!(await t.ready)) return null;
  if (t.dead) return null;
  return new Promise<Float32Array | null>((ok) => {
    const id = ++t.seq;
    const timer = setTimeout(() => {
      t.waiting.delete(id);
      console.warn("[dongni] 声纹线程 5 秒没回话，这一次在主线程算");
      ok(null);
    }, 5000);
    t.waiting.set(id, { ok, timer });
    try {
      // 拷贝一份再转过去：传过去的 ArrayBuffer 会被移交，原来那份不能动
      const buf = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
      t.worker.postMessage({ type: "embed", id, samples: buf }, [buf]);
    } catch {
      clearTimeout(timer);
      t.waiting.delete(id);
      ok(null);
    }
  });
}

function embedNow(samples: Float32Array): Float32Array {
  const ex = g.__dongniVp;
  if (!ex) throw new Error("声纹模型还没载上");
  const s = ex.createStream();
  s.acceptWaveform({ sampleRate: 16000, samples });
  s.inputFinished();
  return normF(ex.compute(s));
}

/** 一段声音的声纹向量（已经归一）：优先在线程上算，不行就在主线程算 */
async function embed(samples: Float32Array): Promise<Float32Array> {
  const off = await embedOnThread(samples);
  if (off && off.length) return normF(off);
  await extractor();
  return embedNow(samples);
}

/** 有没有说话：太安静的段落不拿来录 */
const loud = (x: Float32Array) => {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, x.length)) > 0.01;
};

/** 存着的他的声纹；没录过就是 null */
export function voiceprint(): number[] | null {
  if (g.__dongniVpPrint !== undefined) return g.__dongniVpPrint;
  try {
    g.__dongniVpPrint = (JSON.parse(fs.readFileSync(FILE, "utf8")) as { embedding: number[] }).embedding;
  } catch {
    g.__dongniVpPrint = null;
  }
  return g.__dongniVpPrint;
}

/** 录入：一段 16k PCM（≥ 几秒），切 2 秒一段分别算，平均后存起来（重录就是覆盖） */
export async function enrollVoiceprint(pcm: Buffer): Promise<{ ok: true } | { ok: false; message: string }> {
  const x = toFloat(pcm);
  const seg = 32000;
  const parts: number[][] = [];
  for (let o = 0; o + seg <= x.length; o += seg) {
    const piece = x.subarray(o, o + seg);
    if (loud(piece)) parts.push(Array.from(await embed(piece)));
  }
  if (parts.length < 2) return { ok: false, message: "没怎么听到声音，再说一遍" };
  if (loud(x)) parts.push(Array.from(await embed(x)));
  const avg = norm(parts[0].map((_, i) => parts.reduce((s, p) => s + p[i], 0) / parts.length));
  fs.writeFileSync(FILE, JSON.stringify({ embedding: avg, enrolledAt: Date.now() }));
  g.__dongniVpPrint = avg;
  return { ok: true };
}

/** 这段是不是他：返回相似度（-1～1）；没录过声纹返回 null */
export async function voiceprintScore(pcm: Buffer): Promise<number | null> {
  const me = voiceprint();
  if (!me) return null;
  const e = await embed(toFloat(pcm));
  let s = 0;
  for (let i = 0; i < e.length; i++) s += e[i] * me[i];
  return s;
}

/** 提前把模型载进来（线程 + 主线程都备着），第一次比对别卡那一下 */
export function warmVoiceprint() {
  if (!voiceprint()) return;
  void (async () => {
    if (await thread()?.ready) return;
    await extractor();
  })().catch((e) => console.warn("[dongni] 声纹模型没载上：", e instanceof Error ? e.message : e));
}
