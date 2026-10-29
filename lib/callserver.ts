import "server-only";
import crypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { db, type MessageRow } from "./db";
import { stripImageMarkdown } from "./images";
import { activeMemories, getProfile, scheduleExtraction } from "./memory";
import { PERSONA } from "./persona";
import { todayMe } from "./todayme";
import { voiceConfig } from "./voiceconfig";
import { wardrobeNote } from "./wardrobe";

/**
 * 打电话：页面 ⇄ 这里（本机 3940 端口）⇄ 豆包端到端实时语音。
 *
 * 为什么中间要过一道：豆包要在握手头里带 key，浏览器的 WebSocket 设不了请求头，key 也不该给页面。
 * 通话里她用的是豆包实时模型自己的「脑子」（这样才能边听边说、能被打断、延迟一秒内），
 * 所以开会话时把她的人设、画像、记忆、今天的小日子、最近聊的都塞进去，让它就是她。
 * 通话内容按普通聊天记进库（kind=call），挂了电话她照样记得刚才聊了什么。
 */
const PORT = 3940;
const URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
const APP_KEY = "PlgvMymc7f3tQnJ6";

const g = globalThis as unknown as { __dongniCall?: WebSocketServer };

function frame(event: number, payload: unknown, sid: string | null, type = 0b0001, raw?: Buffer) {
  const body = raw ?? Buffer.from(JSON.stringify(payload));
  const parts: Buffer[] = [Buffer.from([0x11, (type << 4) | 0b0100, raw ? 0x00 : 0x10, 0x00])];
  const e = Buffer.alloc(4);
  e.writeInt32BE(event);
  parts.push(e);
  if (sid) {
    const s = Buffer.from(sid);
    const l = Buffer.alloc(4);
    l.writeUInt32BE(s.length);
    parts.push(l, s);
  }
  const pl = Buffer.alloc(4);
  pl.writeUInt32BE(body.length);
  parts.push(pl, body);
  return Buffer.concat(parts);
}

function parse(buf: Buffer) {
  const type = buf[1] >> 4;
  const flags = buf[1] & 0xf;
  if (type === 0b1111) {
    const sz = buf.readUInt32BE(8);
    return { error: buf.subarray(12, 12 + sz).toString(), event: null as number | null, payload: Buffer.alloc(0) };
  }
  let o = 4;
  let event: number | null = null;
  if (flags & 0b0100) {
    event = buf.readInt32BE(o);
    o += 4;
  }
  const idLen = buf.readUInt32BE(o);
  o += 4 + idLen;
  const sz = buf.readUInt32BE(o);
  o += 4;
  return { error: null as string | null, event, payload: buf.subarray(o, o + sz) };
}

const json = (b: Buffer) => {
  try {
    return JSON.parse(b.toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** 通话里的她：人设 + 他是谁 + 记得的事 + 今天的小日子 + 刚才聊到哪 */
async function systemRole() {
  const recent = (
    db().prepare("SELECT * FROM messages WHERE status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT 12").all() as MessageRow[]
  )
    .reverse()
    .map((m) => `${m.role === "user" ? "他" : "你"}：${stripImageMarkdown(m.content).replace(/\s+/g, " ").slice(0, 120)}`)
    .join("\n");
  const mems = activeMemories()
    .slice(-40)
    .map((m) => `- ${m.content}`)
    .join("\n");
  const today = await Promise.race([wardrobeNote().catch(() => ""), new Promise<string>((ok) => setTimeout(() => ok(""), 800))]);
  return `${PERSONA}

现在你们在打电话，用嗓子聊天：句子短、口语、有来有回，像真打电话那样自然接话、会笑、会追问，别长篇大论，别列条目。他插话你就停下来听。

【他是什么样的人】
${getProfile() || "（还不太了解）"}

【你记得的关于他的事】
${mems || "（还没有）"}

【你今天】
${today}
${todayMe()}

【刚才在聊】
${recent || "（刚开始）"}`.slice(0, 6000);
}

function save(role: "user" | "assistant", text: string) {
  const t = text.trim();
  if (!t) return;
  db()
    .prepare("INSERT INTO messages(client_id, role, content, status, extracted, created_at, kind) VALUES(?, ?, ?, 'done', ?, ?, 'call')")
    .run(role === "user" ? `call-${crypto.randomUUID()}` : null, role, t, role === "user" ? 0 : 1, Date.now());
  if (role === "user") scheduleExtraction(15_000);
}

function bridge(page: WebSocket) {
  const cfg = voiceConfig();
  const tell = (o: unknown) => page.readyState === WebSocket.OPEN && page.send(JSON.stringify(o));
  if (!cfg.apiKey) {
    tell({ type: "error", message: "还没配豆包的 key" });
    return page.close();
  }
  const sid = crypto.randomUUID();
  let ready = false;
  let userText = "";
  let botText = "";
  const up = new WebSocket(URL, {
    headers: {
      "X-Api-Key": cfg.apiKey,
      "X-Api-Resource-Id": "volc.speech.dialog",
      "X-Api-App-Key": APP_KEY,
      "X-Api-Connect-Id": crypto.randomUUID(),
    },
  });
  const close = () => {
    if (botText) save("assistant", botText);
    botText = "";
    try {
      if (up.readyState === WebSocket.OPEN) {
        up.send(frame(102, {}, sid));
        up.send(frame(2, {}, null));
      }
      up.close();
    } catch {}
    try {
      page.close();
    } catch {}
  };

  up.on("open", () => up.send(frame(1, {}, null)));
  up.on("message", async (data: Buffer) => {
    const m = parse(data);
    if (m.error) {
      console.warn("[dongni] 电话那头报错：", m.error);
      tell({ type: "error", message: m.error });
      return close();
    }
    switch (m.event) {
      case 50:
        up.send(
          frame(
            100,
            {
              tts: {
                speaker: cfg.dialogSpeaker || "zh_female_xiaohe_jupiter_bigtts",
                audio_config: { channel: 1, format: "pcm_s16le", sample_rate: 24000 },
              },
              dialog: {
                bot_name: "敏",
                system_role: await systemRole(),
                speaking_style: "活泼俏皮、语气起伏大、会笑，像跟很熟的人打电话，句子短。",
                extra: { strict_audit: false },
              },
            },
            sid,
          ),
        );
        break;
      case 150:
        ready = true;
        tell({ type: "ready" });
        break;
      case 450: // 他开口了：她要是正在说，马上停
        tell({ type: "clear" });
        if (botText) {
          save("assistant", botText);
          botText = "";
        }
        break;
      case 451: {
        const r = json(m.payload) as { results?: { text?: string; is_interim?: boolean }[] };
        const t = r.results?.[0]?.text ?? "";
        if (t) {
          userText = t;
          tell({ type: "you", text: t });
        }
        break;
      }
      case 459: // 他这句说完了
        save("user", userText);
        userText = "";
        break;
      case 550: {
        const t = (json(m.payload).content as string) ?? "";
        if (t) {
          botText += t;
          tell({ type: "her", text: botText });
        }
        break;
      }
      case 559:
        save("assistant", botText);
        botText = "";
        break;
      case 352:
        if (page.readyState === WebSocket.OPEN && m.payload.length) page.send(m.payload);
        break;
      case 152:
      case 153:
        close();
        break;
    }
  });
  up.on("unexpected-response", (_req, res) => {
    tell({ type: "error", message: `连不上（HTTP ${res.statusCode}）` });
    close();
  });
  up.on("error", (e) => {
    tell({ type: "error", message: e.message });
    close();
  });
  up.on("close", () => close());

  // 页面传来的是 16k 单声道 16 位 PCM，原样转给豆包
  page.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary || !ready || up.readyState !== WebSocket.OPEN) return;
    up.send(frame(200, null, sid, 0b0010, Buffer.from(data)));
  });
  page.on("close", () => close());
}

export function startCallServer() {
  if (g.__dongniCall) return;
  const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
  wss.on("connection", (ws) => bridge(ws));
  wss.on("error", (e) => console.warn("[dongni] 电话服务没起来：", e.message));
  g.__dongniCall = wss;
  console.log(`[dongni] 电话服务在 127.0.0.1:${PORT}`);
}
