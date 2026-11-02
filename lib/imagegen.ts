import "server-only";
import { gptimgDir } from "./portable";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getKv, setKv } from "./db";
import { addImageBuffer, imageMarkdown } from "./images";

/**
 * 自己画图给对方看：走本机已有的 gpt-image-2 脚本（~/.agents/skills/gptimg）。
 * 一张两分钱左右。不限次数（对方明确说不要给她加限制）。
 *
 * 画不出来时把真实原因（脚本、接口的原话）交给模型，同时写进日志。
 * 以前这里一律只说「那边没响应」，模型只好自己编理由，编出过「我手里没那个画图工具」——
 * 记忆里却记着「生图没问题」，两边对不上，全靠嘴解释。
 */
const run = promisify(execFile);
const SKILL_DIR = gptimgDir();
const SCRIPT = path.join(SKILL_DIR, "scripts", "gptimg.mjs");
const TIMEOUT_MS = 5 * 60_000;

/**
 * 「生图到底能不能用」只认证据：真的画出来过一张图，才叫能用。
 * 每次真的调用（成功或失败）都把结果和真实原因记在 kv 里；
 * 没说过的、没试过的，状态就是「没验证过」——不许说成好的。
 */
const PROOF_KEY = "imagegen_proof";
/** 同一个失败原因，只让他听一次；之后是沉默，等有新情况或他主动问 */
const TOLD_KEY = "imagegen_fail_told";
const SAME_REASON_QUIET_MS = 3 * 60 * 60_000;
const PROBE_PROMPT = "一朵白色小花，浅灰背景，极简";
const PROBE_TIMEOUT_MS = 90_000;
const PROOF_FRESH_MS = 10 * 60_000;

export type GenOutcome = { ok: true; markdown: string; id: number } | { ok: false; message: string };
export type GenProof = { at: number; ok: boolean; why: string; id?: number };
type Told = { why: string; at: number };

function readTold(): Told | null {
  try {
    const raw = getKv(TOLD_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Told;
    return t && typeof t.at === "number" ? t : null;
  } catch {
    return null;
  }
}

/**
 * 失败时交给模型的话。同一个原因短时间内只播报一次：
 * 重复的失败告诉她「这个原因已经说过了」，让她别再刷同一句，除非真有新的。
 */
function failNote(why: string): string {
  const now = Date.now();
  const prev = readTold();
  if (prev && prev.why === why && now - prev.at < SAME_REASON_QUIET_MS) {
    const mins = Math.max(1, Math.round((now - prev.at) / 60000));
    return `图还是没画出来，原因跟 ${mins} 分钟前那次一模一样：${why}。这个原因你已经跟他说过了，这次别再重复播报同一句；除非你换了别的画法、拿到了新情况，或者他主动问起，就说一句真正新的，否则别提，接着刚才的话往下说。`;
  }
  try {
    setKv(TOLD_KEY, JSON.stringify({ why, at: now } satisfies Told));
  } catch {
    // 记不下也不影响出图
  }
  return `图没画出来，真实原因是：${why}。跟他用大白话说这个原因（别提路径、别贴代码），别说自己手里没有画图工具。`;
}

function clearTold() {
  try {
    setKv(TOLD_KEY, "");
  } catch {
    // 无关紧要
  }
}

function keepProof(ok: boolean, why: string, id?: number) {
  try {
    setKv(PROOF_KEY, JSON.stringify({ at: Date.now(), ok, why: why.slice(0, 200), id } satisfies GenProof));
  } catch {
    // 记不下也不影响这次出图
  }
}

export function lastGenProof(): GenProof | null {
  try {
    const v = getKv(PROOF_KEY);
    const p = v ? (JSON.parse(v) as GenProof) : null;
    return p && typeof p.at === "number" ? p : null;
  } catch {
    return null;
  }
}

/** 用一句话说清生图现在的真实状态（写进提示词，她照着说） */
export function imagegenStatus(): string {
  return `生图用的模型是 ${process.env.GPTIMG_MODEL || "gpt-image-2"}（他问起就照这个说，别猜别的）。${proofLine()}`;
}

function proofLine(): string {
  const p = lastGenProof();
  if (!p) return "生图：还没真画出来过一次（没验证过）。要说自己能画，先用 generate_image 真画一张；在那之前就说没试过。";
  const mins = Math.max(1, Math.round((Date.now() - p.at) / 60000));
  if (p.ok) return `生图：${mins} 分钟前真的画出来过一张${p.id ? `（第 ${p.id} 张）` : ""}，能用。`;
  return `生图：${mins} 分钟前真的试着画了一张，没画出来，真实原因是：${p.why}。这就是生图现在的真实状态——别说是好的，别说是修好了。`;
}

/** 真调一次生成接口拿图：拿到才算通过，拿不到就把真实原因留着；十分钟内试过的不重复花钱试 */
let proving: Promise<GenProof | null> | null = null;
export async function proveImagegen(): Promise<GenProof | null> {
  const last = lastGenProof();
  if (last && Date.now() - last.at < PROOF_FRESH_MS) return last;
  if (proving) return proving;
  proving = (async () => {
    await generateImage(PROBE_PROMPT, { quality: "low", timeoutMs: PROBE_TIMEOUT_MS, probe: true });
    const p = lastGenProof();
    console.log(`[dongni] 生图自检：${p?.ok ? "画出来了" : `没画出来（${p?.why ?? "不知道什么原因"}）`}`);
    return p;
  })()
    .catch(() => lastGenProof())
    .finally(() => {
      proving = null;
    });
  return proving;
}

/** key 在 skill 目录的 .env 里（也可能在环境变量里）：缺了先照实说，别等脚本跑一半才失败 */
function notInstalled(): string | null {
  if (!fs.existsSync(SCRIPT)) return `生图脚本没装（找不到 ${SCRIPT}）`;
  if (process.env.GPTIMG_API_KEY?.trim()) return null;
  try {
    if (/^\s*GPTIMG_API_KEY\s*=\s*\S/m.test(fs.readFileSync(path.join(SKILL_DIR, ".env"), "utf8"))) return null;
  } catch {
    // 没有 .env 也算没配
  }
  return "生图用的 key 没配（skill 的 .env 里没有 GPTIMG_API_KEY）";
}

/** 脚本的报错原话在 stderr 里，e.message 只有一行 Command failed，看不出毛病 */
function whyFailed(e: unknown, timeoutMs: number) {
  const err = e as { stderr?: string; message?: string; killed?: boolean; signal?: string };
  if (err.killed || err.signal) return `画图卡住了（${Math.round(timeoutMs / 1000)} 秒没画完）`;
  const lines = String(err.stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = (lines.pop() ?? err.message ?? "").replace(/^gptimg:\s*/, "").replace(/\s+/g, " ").trim();
  return last.slice(0, 160) || "不知道什么原因";
}

export async function generateImage(prompt: string, opts?: { quality?: "low" | "medium" | "high" | "auto"; timeoutMs?: number; ref?: string; probe?: boolean }): Promise<GenOutcome> {
  const p = prompt.trim();
  if (!p) return { ok: false, message: "没说要画什么，先问清一句再画。" };
  const missing = notInstalled();
  if (missing) {
    console.error(`[dongni] 画不了：${missing}`);
    keepProof(false, missing);
    if (opts?.probe) return { ok: false, message: `画不了，真实原因是：${missing}。` };
    return { ok: false, message: failNote(missing) };
  }

  const quality = opts?.quality ?? "medium";
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const out = path.join(os.tmpdir(), `dongni-gen-${crypto.randomUUID()}.png`);
  try {
    const { stdout } = await run(
      process.execPath,
      [SCRIPT, p, "-o", out, "--size", opts?.ref ? "1024x1536" : "1024x1024", "--quality", quality, "--json", ...(opts?.ref ? ["--ref", opts.ref] : [])],
      { timeout: timeoutMs, maxBuffer: 20 << 20 },
    );
    const info = JSON.parse(stdout.trim()) as { files?: string[] };
    const file = info.files?.[0];
    if (!file) throw new Error("脚本跑完了，但没产出图片文件");
    const buf = fs.readFileSync(file);
    fs.rmSync(file, { force: true });
    const rec = addImageBuffer(buf, "image/png", "gen", p);
    keepProof(true, "", rec.id);
    clearTold();
    console.log(`[dongni] 画好一张图 #${rec.id}`);
    return { ok: true, markdown: imageMarkdown(rec.id), id: rec.id };
  } catch (e) {
    const why = whyFailed(e, timeoutMs);
    keepProof(false, why);
    console.warn(`[dongni] 画图失败：${why}`);
    if (opts?.probe) return { ok: false, message: `图没画出来，真实原因是：${why}。` };
    return { ok: false, message: failNote(why) };
  } finally {
    fs.rmSync(out, { force: true });
  }
}