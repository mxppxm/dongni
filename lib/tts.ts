import "server-only";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * 把回复念出来：跟语音简报用的是同一套（微软神经语音「晓晓」edge-tts）。
 * 第一次点按钮时才合成，之后走缓存；念不出来就返回 null，界面上只说一句「这条念不出来」。
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

/** 合成一条回复的语音，返回 mp3 路径；失败返回 null */
export async function synthesize(id: number, content: string): Promise<string | null> {
  const text = speakableText(content);
  if (!text) return null;
  const key = crypto.createHash("sha1").update(`${VOICE}:${text}`).digest("hex").slice(0, 12);
  const file = path.join(AUDIO_DIR, `${id}-${key}.mp3`);
  try {
    const st = fs.statSync(file);
    if (st.size > 512) return file;
  } catch {
    // 还没合成过
  }
  const running = inflight.get(file);
  if (running) return running;
  if (!binary) {
    console.warn("[dongni] 没找到 edge-tts，念不了");
    return null;
  }

  const task = (async () => {
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
      inflight.delete(file);
    }
  })();
  inflight.set(file, task);
  return task;
}