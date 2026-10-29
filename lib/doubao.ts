import "server-only";
import crypto from "node:crypto";
import { voiceConfig, voiceReady } from "./voiceconfig";

/**
 * 豆包（火山引擎）语音：合成（她说给你听）和识别（听懂你说的）。
 *
 * 走的是豆包语音的 HTTP 接口（Node 自带的 WebSocket 设不了鉴权头，流式那套要额外依赖，这里不引）：
 * - 合成：新版控制台用 v3 单向流式（seed-tts-2.0，一次请求流式返回 mp3 片段）；
 *         旧版控制台用 v1 非流式（appid + access_token + cluster=volcano_tts）。
 * - 识别：录音文件极速版（api/v3/auc/bigmodel/recognize/flash），一段音频一次请求直接出文字。
 * 没配 key、接口报错、超时，一律返回空/失败，调用方退回旧方案或者让她开口要 key，绝不抛到界面上。
 */
const TTS_V3 = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const TTS_V1 = "https://openspeech.bytedance.com/api/v1/tts";
const ASR_FLASH = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";

/** 各自控制台里能用的默认音色：2.0（v3）/ 1.0（v1） */
const DEFAULT_SPEAKER_V3 = "zh_female_vv_uranus_bigtts";
const DEFAULT_SPEAKER_V1 = "zh_female_cancan_mars_bigtts";
const DEFAULT_TTS_RESOURCE = "seed-tts-2.0";
const DEFAULT_ASR_RESOURCE = "volc.bigasr.auc_turbo";
const TIMEOUT_MS = 30_000;

export const ttsReady = () => voiceReady().tts;
export const asrReady = () => voiceReady().asr;

const warn = (what: string, e: unknown) =>
  console.warn(`[dongni] 豆包${what}失败：${e instanceof Error ? e.message : String(e)}`);

async function post(url: string, headers: Record<string, string>, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** 把一段文字合成为 mp3（豆包）；没配或失败返回 null */
export async function doubaoTts(text: string): Promise<{ audio: Buffer; mime: string } | null> {
  const cfg = voiceConfig();
  const said = text.trim();
  if (!said) return null;
  try {
    if (cfg.apiKey) {
      // 先想好这句该怎么念（哪里惊讶、哪里笑、哪里拖长音），再交给豆包 2.0 按这个语气念——不然念出来平平的
      const { script, direction } = await howToSay(said);
      return await ttsV3(script, cfg.apiKey, cfg.speaker || DEFAULT_SPEAKER_V3, cfg.ttsResourceId, direction);
    }
    if (cfg.appId && cfg.accessToken) return await ttsV1(said, cfg.appId, cfg.accessToken, cfg.speaker || DEFAULT_SPEAKER_V1, cfg.cluster);
    return null;
  } catch (e) {
    warn("合成", e);
    return null;
  }
}

/** 从一段流式回包里把每个 JSON 对象拆出来（有的版本按行发，有的是 SSE，有的干脆连在一起） */
function* jsonObjects(raw: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        yield raw.slice(start, i + 1);
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
}

/** 新版控制台：单向流式 HTTP，返回一串 JSON，每个里带一段 base64 音频 */
/**
 * 念之前先改成「口播稿」+ 一句表演提示。
 * 实测（同一句吐槽、同一个声音）：只给豆包 2.0 加语境提示，音域只从 103 涨到 117；
 * 把字改成真人说话的样子（「又——十点？？」「哎哟喂」「……」「～」）音域到 141，再加提示到 184、音调也明显上扬。
 * 所以起伏主要靠「字怎么写」，提示只是锦上添花。意思不改，只改说法。
 */
async function howToSay(text: string): Promise<{ script: string; direction: string }> {
  try {
    const { completeJson } = await import("./llm");
    const r = await Promise.race([
      completeJson<{ script: string; direction: string }>(
        [
          {
            role: "system",
            content: `你是配音导演兼口播编辑。说话的人是一个 20 岁、活泼爱闹、情绪写在脸上的女生，在跟很熟的人聊天。
把下面这段要念出来的话改成她真开口时的「口播稿」：
- 意思、事实、数字一个都不改，不加新内容，长度差不多。
- 加真人说话的痕迹：语气词（哎呀、诶、哇、哎哟喂、嗯……）、拉长音用「——」或「～」、惊讶用「？？」或「！！」、犹豫用「……」、笑就写「哈哈」。
- 情绪要放大一点，起伏要明显；温柔、难过的话就写得轻、慢、软，多停顿。
- 去掉表情符号、链接、代码、markdown 符号。
再写一句表演提示（中文，60 字以内）：整体情绪、哪里重读或拖长、哪里带笑、语速。
只输出 JSON：{"script":"...","direction":"..."}`,
          },
          { role: "user", content: text.slice(0, 800) },
        ],
        800,
        "none",
      ),
      new Promise<{ script: string; direction: string }>((ok) => setTimeout(() => ok({ script: "", direction: "" }), 5000)),
    ]);
    const script = r.script?.trim() ?? "";
    // 改坏了（太短、太长）就用原文
    const ok = script && script.length > text.length * 0.6 && script.length < text.length * 1.8 + 20;
    return { script: ok ? script : text, direction: r.direction?.trim() ?? "" };
  } catch {
    return { script: text, direction: "" };
  }
}

async function ttsV3(text: string, apiKey: string, speaker: string, resourceId?: string, direction = "") {
  const res = await post(
    TTS_V3,
    {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId || DEFAULT_TTS_RESOURCE,
      "X-Api-Request-Id": crypto.randomUUID(),
    },
    {
      req_params: {
        text,
        speaker,
        audio_params: { format: "mp3", sample_rate: 24000 },
        ...(direction ? { additions: JSON.stringify({ context_texts: [direction] }) } : {}),
      },
    },
  );
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = await res.text();
  const parts: Buffer[] = [];
  let code = 0;
  let message = "";
  for (const chunk of jsonObjects(raw)) {
    let obj: { code?: number; message?: string; data?: string };
    try {
      obj = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (typeof obj.data === "string" && obj.data) parts.push(Buffer.from(obj.data, "base64"));
    if (typeof obj.code === "number" && obj.code !== 0) {
      code = obj.code;
      message = obj.message ?? "";
    }
  }
  const audio = Buffer.concat(parts);
  if (audio.length > 512) return { audio, mime: "audio/mpeg" };
  if (code) throw new Error(`tts ${code}: ${message || "合成失败"}`);
  return null;
}

/** 旧版控制台：一次请求，整段 base64 回来 */
async function ttsV1(text: string, appId: string, accessToken: string, speaker: string, cluster?: string) {
  const res = await post(
    TTS_V1,
    { Authorization: `Bearer;${accessToken}` },
    {
      app: { appid: appId, token: accessToken, cluster: cluster || "volcano_tts" },
      user: { uid: "dongni" },
      audio: { voice_type: speaker, encoding: "mp3", speed_ratio: 1.0 },
      request: { reqid: crypto.randomUUID(), text, operation: "query" },
    },
  );
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { code?: number; message?: string; data?: string };
  if (body.code !== 3000 || !body.data) throw new Error(`tts ${body.code ?? "?"}: ${body.message ?? "没有音频"}`);
  const audio = Buffer.from(body.data, "base64");
  return audio.length > 512 ? { audio, mime: "audio/mpeg" } : null;
}

export type AsrResult = { ok: true; text: string } | { ok: false; why: "missing" | "silent" | "failed" };

/** 听一段 wav（16k 单声道）里说了什么；失败给出原因，界面据此说话 */
export async function doubaoAsr(wav: Buffer): Promise<AsrResult> {
  const cfg = voiceConfig();
  const auth: Record<string, string> = {};
  if (cfg.appId && cfg.accessToken) {
    auth["X-Api-App-Key"] = cfg.appId;
    auth["X-Api-Access-Key"] = cfg.accessToken;
  } else if (cfg.apiKey) {
    auth["X-Api-Key"] = cfg.apiKey;
  } else return { ok: false, why: "missing" };

  try {
    const res = await post(
      ASR_FLASH,
      {
        ...auth,
        "X-Api-Resource-Id": cfg.asrResourceId || DEFAULT_ASR_RESOURCE,
        "X-Api-Request-Id": crypto.randomUUID(),
        "X-Api-Sequence": "-1",
      },
      {
        user: { uid: cfg.appId || "dongni" },
        audio: { data: wav.toString("base64"), format: "wav" },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
      },
    );
    const code = res.headers.get("X-Api-Status-Code") ?? "";
    if (code === "20000003") return { ok: false, why: "silent" };
    if (code !== "20000000") {
      const detail = res.headers.get("X-Api-Message") || (await res.text()).slice(0, 200);
      throw new Error(`asr ${code || res.status}: ${detail}`);
    }
    const body = (await res.json()) as { result?: { text?: string } };
    const text = (body.result?.text ?? "").trim();
    return text ? { ok: true, text } : { ok: false, why: "silent" };
  } catch (e) {
    warn("识别", e);
    return { ok: false, why: "failed" };
  }
}