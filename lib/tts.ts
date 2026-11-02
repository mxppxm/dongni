import "server-only";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stripLeaks, stripPaths } from "./textclean";

/**
 * 语音的小工具：把 Markdown 整理成能念的话（电话、语音消息共用），以及 edge-tts 兜底合成。
 * 「每条回复都念出来」那套已经拿掉了——它在每条回复写完后都合成一遍语音，打字聊天也在花语音的钱。
 */
const run = promisify(execFile);
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(process.cwd(), "data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const VOICE = "zh-CN-XiaoxiaoNeural";
const MAX_CHARS = 600;
const TIMEOUT_MS = 60_000;

const CANDIDATES = [
  path.join(os.homedir(), ".cache", "edge-tts-venv", "bin", "edge-tts"),
  "/opt/homebrew/bin/edge-tts",
  "/usr/local/bin/edge-tts",
];

const binary = CANDIDATES.find((p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

const inflight = ((globalThis as unknown as { __dongniTts?: Map<string, Promise<string | null>> }).__dongniTts ??= new Map());

/** Markdown 转成能念的话：代码、表格线、链接这些都不念 */
export function speakableText(markdown: string): string {
  let t = markdown;
  t = t.replace(/```[\s\S]*?```/g, "。");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "。");
  // 念的时候不读磁盘路径，也不读模型漏出来的调用残片（乱码）
  t = stripLeaks(t);
  t = stripPaths(t);
  t = t.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, "");
  t = t.replace(/^\s*\|/gm, "").replace(/\|\s*$/gm, "");
  t = t.replace(/\s*\|\s*/g, "、");
  t = t.replace(/、{2,}/g, "、").replace(/^、|、$/gm, "");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d{1,9}[.)])\s*/gm, "");
  t = t.replace(/[*_~]/g, "");
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "");
  t = t.replace(/\n{2,}/g, "。");
  t = t.replace(/([。！？，])(?:\s*\1)+/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > MAX_CHARS) {
    const cut = t.slice(0, MAX_CHARS);
    const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("，"));
    t = (stop > MAX_CHARS * 0.5 ? cut.slice(0, stop + 1) : cut).trim();
  }
  return t;
}

/** 只用旧的 edge-tts 合成（豆包没配 / 没合成成功时的兜底），同一个文件缓存 */
export async function synthesizeFallback(source: string): Promise<string | null> {
  const text = speakableText(source);
  if (!text || !binary) return null;
  const key = crypto.createHash("sha1").update(`edge:${text}`).digest("hex").slice(0, 12);
  const file = path.join(AUDIO_DIR, `edge-${key}.mp3`);
  try {
    if (fs.statSync(file).size > 512) return file;
  } catch {
    // 还没合成过
  }
  const running = inflight.get(file);
  if (running) return running;
  const task = speakWithEdge(file, text, key);
  inflight.set(file, task);
  task.finally(() => inflight.delete(file));
  return task;
}

/** 老路子：微软「晓晓」念一遍，写到同一个文件里 */
async function speakWithEdge(file: string, text: string, key: string): Promise<string | null> {
  if (!binary) return null;
  const tmp = path.join(os.tmpdir(), `dongni-tts-${key}.txt`);
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(tmp, text, "utf8");
  try {
    await run(binary, ["--voice", VOICE, "--file", tmp, "--write-media", file], { timeout: TIMEOUT_MS, maxBuffer: 4 << 20 });
    return fs.statSync(file).size > 512 ? file : null;
  } catch (e) {
    console.warn("[dongni] 语音合成失败：", e instanceof Error ? e.message : e);
    fs.rmSync(file, { force: true });
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
