import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 豆包（火山引擎）语音的凭据：只存在本机配置文件里，不进代码、不进仓库。
 * 缺了不算错——调用方先问 configured()，没有就退回到原来那套念法/或者让她开口要。
 *
 * 文件默认在 ~/.config/dongni/voice.json（可用 DONGNI_VOICE_CONFIG 指到别处），形如：
 * { "appId": "旧版控制台 APP ID", "accessToken": "旧版控制台 Access Token",
 *   "apiKey": "新版控制台 API Key", "speaker": "音色 ID" }
 * 也认环境变量 DONGNI_VOICE_APP_ID / DONGNI_VOICE_ACCESS_TOKEN / DONGNI_VOICE_API_KEY / DONGNI_VOICE_SPEAKER。
 */
export type VoiceConfig = {
  appId: string;
  accessToken: string;
  apiKey: string;
  speaker: string;
  ttsResourceId: string;
  asrResourceId: string;
  cluster: string;
};

type Raw = Partial<VoiceConfig>;

const FILE =
  process.env.DONGNI_VOICE_CONFIG || path.join(os.homedir(), ".config", "dongni", "voice.json");

let cache: { mtime: number; raw: Raw } | null = null;

/** 读配置文件；没有、坏了、没权限都当成「没配」，不影响其他功能 */
function readRaw(): Raw {
  try {
    const st = fs.statSync(FILE);
    if (cache && cache.mtime === st.mtimeMs) return cache.raw;
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Raw;
    cache = { mtime: st.mtimeMs, raw: raw && typeof raw === "object" ? raw : {} };
    return cache.raw;
  } catch {
    return cache?.raw ?? {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** 配置文件 + 环境变量合到一起（环境变量优先，方便临时换 key） */
export function voiceConfig(): VoiceConfig {
  const raw = readRaw();
  return {
    appId: str(process.env.DONGNI_VOICE_APP_ID) || str(raw.appId),
    accessToken: str(process.env.DONGNI_VOICE_ACCESS_TOKEN) || str(raw.accessToken),
    apiKey: str(process.env.DONGNI_VOICE_API_KEY) || str(raw.apiKey),
    speaker: str(process.env.DONGNI_VOICE_SPEAKER) || str(raw.speaker),
    ttsResourceId: str(raw.ttsResourceId),
    asrResourceId: str(raw.asrResourceId),
    cluster: str(raw.cluster),
  };
}

/** 有没有凭据：新版控制台只要 apiKey，旧版控制台要 appId + accessToken */
export function voiceReady() {
  const c = voiceConfig();
  const credential = !!c.apiKey || (!!c.appId && !!c.accessToken);
  return {
    configured: credential,
    tts: credential,
    asr: credential,
    speaker: c.speaker,
    path: FILE,
  };
}

/** 把 key 存进本机配置文件（合并，不覆盖别的字段），文件权限只给自己读 */
export function saveVoiceConfig(patch: Raw): { ok: boolean; error?: string } {
  try {
    const next: Raw = { ...readRaw() };
    for (const k of ["appId", "accessToken", "apiKey", "speaker", "ttsResourceId", "asrResourceId", "cluster"] as const) {
      const v = str(patch[k]);
      if (v) next[k] = v;
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, FILE);
    try {
      fs.chmodSync(FILE, 0o600);
    } catch {
      // 权限设不上也照样能用
    }
    cache = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}