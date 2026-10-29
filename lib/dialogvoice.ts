import "server-only";
import crypto from "node:crypto";
import WebSocket from "ws";
import { voiceConfig } from "./voiceconfig";

/**
 * 用豆包「端到端实时语音大模型」把她的话说出来——就是豆包 App 里聊天的那副嗓子：
 * 会笑、会换气、语气跟着意思走，不像语音合成那样「念课文」。
 *
 * 用法上取巧：每条回复开一个短会话，用 SayHello 让它把指定的话原样说出来（不经它自己的大脑）。
 * 实测开会话约 0.2 秒、第一段声音约 0.5 秒，一句话一两秒就合成完。输出 ogg/opus，浏览器能边收边放。
 */
const URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
const APP_KEY = "PlgvMymc7f3tQnJ6"; // 文档里给的固定值
export const DIALOG_SPEAKERS = ["zh_female_vv_jupiter_bigtts", "zh_female_xiaohe_jupiter_bigtts"];
const DEFAULT_SPEAKER = DIALOG_SPEAKERS[0];

export const dialogEnabled = () => {
  const c = voiceConfig();
  return !!c.apiKey && c.engine === "dialog";
};

function frame(event: number, payload: unknown, sid: string | null) {
  const body = Buffer.from(JSON.stringify(payload));
  const parts = [Buffer.from([0x11, (0b0001 << 4) | 0b0100, 0x10, 0x00])];
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
    const code = buf.readUInt32BE(4);
    const sz = buf.readUInt32BE(8);
    return { error: `${code} ${buf.subarray(12, 12 + sz).toString()}`, event: null as number | null, payload: Buffer.alloc(0) };
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

/** 把一段话用她的嗓子说出来，每收到一段 ogg 音频就交给 onChunk。成功返回 true。 */
export function sayViaDialog(text: string, onChunk: (b: Buffer) => void): Promise<boolean> {
  const cfg = voiceConfig();
  const said = text.trim();
  if (!said || !cfg.apiKey) return Promise.resolve(false);
  const sid = crypto.randomUUID();
  return new Promise((resolve) => {
    let got = false;
    let settled = false;
    const done = (ok: boolean, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (why) console.warn(`[dongni] 实时语音没说成：${why}`);
      try {
        ws.close();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(got, "30 秒没说完"), 30_000);
    const ws = new WebSocket(URL, {
      headers: {
        "X-Api-Key": cfg.apiKey,
        "X-Api-Resource-Id": "volc.speech.dialog",
        "X-Api-App-Key": APP_KEY,
        "X-Api-Connect-Id": crypto.randomUUID(),
      },
    });
    ws.on("open", () => ws.send(frame(1, {}, null)));
    ws.on("message", (data: Buffer) => {
      const m = parse(data);
      if (m.error) return done(got, m.error);
      switch (m.event) {
        case 50: // 连上了：开一个只说话、不听麦克风的会话
          ws.send(
            frame(
              100,
              {
                tts: { speaker: cfg.dialogSpeaker || DEFAULT_SPEAKER, audio_config: { channel: 1, format: "ogg_opus", sample_rate: 24000 } },
                dialog: {
                  bot_name: "敏",
                  system_role: "你是敏，20 岁的女生，活泼、可爱、好动，在跟很熟的朋友聊天。",
                  speaking_style: "说话自然、有起伏，开心时轻快带笑，温柔时轻一点慢一点，像真人聊天，不像朗读。",
                  extra: { input_mod: "text" },
                },
              },
              sid,
            ),
          );
          break;
        case 150: // 会话开好：让它原样说出这段话
          ws.send(frame(300, { content: said }, sid));
          break;
        case 352:
          if (m.payload.length) {
            got = true;
            onChunk(Buffer.from(m.payload));
          }
          break;
        case 359: // 说完了
          try {
            ws.send(frame(102, {}, sid));
          } catch {}
          done(got);
          break;
      }
    });
    ws.on("unexpected-response", (_req, res) => done(false, `HTTP ${res.statusCode}`));
    ws.on("error", (e) => done(got, e.message));
    ws.on("close", () => done(got));
  });
}
