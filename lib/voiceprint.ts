import "server-only";
import fs from "node:fs";
import path from "node:path";

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

function embed(ex: Extractor, samples: Float32Array) {
  const s = ex.createStream();
  s.acceptWaveform({ sampleRate: 16000, samples });
  s.inputFinished();
  return norm(ex.compute(s));
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
  const ex = await extractor();
  const x = toFloat(pcm);
  const seg = 32000;
  const parts: number[][] = [];
  for (let o = 0; o + seg <= x.length; o += seg) {
    const piece = x.subarray(o, o + seg);
    if (loud(piece)) parts.push(embed(ex, piece));
  }
  if (parts.length < 2) return { ok: false, message: "没怎么听到声音，再说一遍" };
  if (loud(x)) parts.push(embed(ex, x));
  const avg = norm(parts[0].map((_, i) => parts.reduce((s, p) => s + p[i], 0) / parts.length));
  fs.writeFileSync(FILE, JSON.stringify({ embedding: avg, enrolledAt: Date.now() }));
  g.__dongniVpPrint = avg;
  return { ok: true };
}

/** 这段是不是他：返回相似度（-1～1）；没录过声纹返回 null */
export async function voiceprintScore(pcm: Buffer): Promise<number | null> {
  const me = voiceprint();
  if (!me) return null;
  const e = embed(await extractor(), toFloat(pcm));
  let s = 0;
  for (let i = 0; i < e.length; i++) s += e[i] * me[i];
  return s;
}

/** 提前把模型载进来，第一次比对别卡那一下 */
export function warmVoiceprint() {
  if (voiceprint()) void extractor().catch((e) => console.warn("[dongni] 声纹模型没载上：", e instanceof Error ? e.message : e));
}
