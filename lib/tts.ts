import "server-only";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { doubaoTts, ttsReady } from "./doubao";
import { voiceConfig } from "./voiceconfig";

/**
 * 把回复念出来：配了豆包（火山引擎）就用豆包的声音，没配或没合成出来就退回原来那套
 * （微软神经语音「晓晓」edge-tts）。第一次点按钮时才合成，之后走缓存；
 * 念不出来就返回 null，界面上只说一句「这条念不出来」。
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
  const useDoubao = ttsReady();
  const voiceTag = useDoubao ? `doubao:${voiceConfig().speaker || "default"}` : VOICE;
  const key = crypto.createHash("sha1").update(`${voiceTag}:${text}`).digest("hex").slice(0, 12);
  const file = path.join(AUDIO_DIR, `${id}-${key}.mp3`);
  try {
    const st = fs.statSync(file);
    if (st.size > 512) return file;
  } catch {
    // 还没合成过
  }
  const running = inflight.get(file);
  if (running) return running;

  // 豆包优先：配了就用它的声音，合成失败再往下走旧路子，别把这条回复变成没声
  if (useDoubao) {
    const task = (async () => {
      const got = await doubaoTts(text);
      if (got) {
        try {
          fs.mkdirSync(AUDIO_DIR, { recursive: true });
          fs.writeFileSync(file, got.audio);
          if (fs.statSync(file).size > 512) return file;
        } catch (e) {
          console.warn("[dongni] 豆包语音写盘失败：", e instanceof Error ? e.message : e);
        }
      } else {
        console.warn("[dongni] 豆包没合成出来，退回 edge-tts");
      }
      return binary ? synthesizeFallback(text) : null;
    })();
    inflight.set(file, task);
    task.finally(() => inflight.delete(file));
    return task;
  }

  if (!binary) {
    console.warn("[dongni] 没找到 edge-tts，念不了");
    return null;
  }
  const task = speakWithEdge(file, text, key);
  inflight.set(file, task);
  task.finally(() => inflight.delete(file));
  return task;
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