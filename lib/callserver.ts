import "server-only";
import crypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { db, type MessageRow } from "./db";
import { stripImageMarkdown } from "./images";
import { activeMemories, getProfile } from "./memory";
import { PERSONA } from "./persona";
import { todayMe } from "./todayme";
import { voiceConfig } from "./voiceconfig";
import { startReply } from "./chat";
import { replyMode } from "./llm";
import { speakableText } from "./tts";
import { wardrobeNote } from "./wardrobe";

/**
 * 打电话：页面 ⇄ 这里（本机 3940 端口）⇄ 豆包端到端实时语音。
 *
 * 为什么中间要过一道：豆包要在握手头里带 key，浏览器的 WebSocket 设不了请求头，key 也不该给页面。
 * 分工：豆包实时语音只当「耳朵和嘴」——听你说话、判断你说完没、你插话时打断、用真人语气说出来；
 * 「脑子」还是她自己的（同一个大模型、同一份记忆、同样能查电脑、写文件、设提醒）：
 * 你一句说完，识别出的文字走普通聊天那条路生成回复，边生成边用 ChatTTSText 交给豆包念出来。
 * 豆包自己也会生成一个回复，那个不播（按 tts_type 区分，只放 chat_tts_text 的声音）。
 */
const PORT = Number(process.env.DONGNI_CALL_PORT) || 3940; // 页面按「网页端口 + 1」来连
const URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
const APP_KEY = "PlgvMymc7f3tQnJ6";

const g = globalThis as unknown as { __dongniCall?: WebSocketServer };
let T0 = 0;

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
  let playing = ""; // 当前这句是谁的声音：chat_tts_text 是她的脑子说的，其他是豆包自己的，不播
  let turn = 0; // 第几轮回复；他插话后，上一轮剩下的话就别再送去念了
  /** 把她的回复一句句送去念（流式：start → content… → end） */
  const speaker = (myTurn: number) => {
    let started = false;
    let pending = "";
    let finished = false;
    const send = (content: string, end: boolean) => {
      if (myTurn !== turn || up.readyState !== WebSocket.OPEN) return;
      if (!started) console.log(`[dongni][call] +${Date.now() - T0}ms 送出第一句：${content.slice(0, 20)}`);
      up.send(frame(500, { start: !started, content, end }, sid));
      started = true;
    };
    return {
      push(delta: string) {
        if (finished) return;
        pending += delta;
        // 说完一句（句号问号感叹号换行）就送出去，别等整段
        // 第一句只要凑够几个字、碰到逗号就先送，早一点出声；后面按整句送，语气更连贯
        const m = pending.match(/^[\s\S]*[。！？!?～\n]/) ?? (!started && pending.length >= 8 ? pending.match(/^[\s\S]*[，,、]/) : null);
        if (m) {
          const said = speakableText(m[0]);
          pending = pending.slice(m[0].length);
          if (said) send(said, false);
        }
      },
      end() {
        if (finished) return;
        finished = true;
        const said = speakableText(pending);
        if (said) send(said, false);
        if (started) send("", true);
      },
    };
  };
  /** 你这句说完了：交给她自己的脑子回 */
  const answer = (text: string) => {
    const myTurn = ++turn;
    const say = speaker(myTurn);
    let assistantId = 0;
    let said = false;
    replyMode.run({ fast: true }, () => startReply(`call-${crypto.randomUUID()}`, text, (e) => {
      if (e.type === "meta") {
        assistantId = e.assistantId;
        // 通话里说的话也是聊天记录，只是标一下来自电话（页面不会再自动念一遍）
        db().prepare("UPDATE messages SET kind = 'call' WHERE id IN (?, ?)").run(e.userId, e.assistantId);
      } else if (e.type === "delta") {
        if (!botText) console.log(`[dongni][call] +${Date.now() - T0}ms 第一个字`);
        say.push(e.text);
        botText += e.text;
        tell({ type: "her", text: botText });
      } else if (e.type === "mood" && (e.mood === "run" || e.mood === "draw") && !botText && !said) {
        // 要去干活了（查电脑、写文件、画画）还一个字没说：先应一声，别让电话那头干等着
        said = true;
        const lines = e.mood === "draw" ? ["好，我画一下，等我会儿～", "行，我这就画，稍等哦"] : ["好，我弄一下，等我一会儿～", "行，我去看看，马上", "嗯嗯，我来弄，稍等哈"];
        say.push(lines[Math.floor(Math.random() * lines.length)] + "\n");
      } else if (e.type === "reset") {
        // 调工具前的铺垫话（「我去写一下」）在电话里留着——已经念出去了
      } else if (e.type === "done") {
        say.end();
        botText = "";
        void assistantId;
      }
    }));
  };
  const up = new WebSocket(URL, {
    headers: {
      "X-Api-Key": cfg.apiKey,
      "X-Api-Resource-Id": "volc.speech.dialog",
      "X-Api-App-Key": APP_KEY,
      "X-Api-Connect-Id": crypto.randomUUID(),
    },
  });
  const close = () => {
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
      case 450: // 他开口了：她要是正在说，马上停；上一轮还没念的也不念了
        tell({ type: "clear" });
        turn++;
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
      case 459: // 他这句说完了：交给她自己的脑子
        T0 = Date.now();
        console.log(`[dongni][call] 459 说完`);
        if (userText.trim()) answer(userText.trim());
        userText = "";
        break;
      case 350: // 新的一句开始念：记下是谁的
        playing = (json(m.payload).tts_type as string) ?? "";
        console.log(`[dongni][call] +${Date.now() - T0}ms 开始念 ${playing}`);
        break;
      case 352: // 只放她自己脑子说的那些（豆包自己生成的回复不播）
        if (playing === "chat_tts_text" && page.readyState === WebSocket.OPEN && m.payload.length) page.send(m.payload);
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
