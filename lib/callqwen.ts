import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { db } from "./db";
import { scheduleExtraction } from "./memory";
import { callEnded, callStarted } from "./presence";
import { HONESTY, selfState } from "./selfstate";
import { runTool, TOOLS } from "./tools";
import { speakableText } from "./tts";

/**
 * 打电话（通义 Qwen 实时语音）：页面 ⇄ 这里（本机 3940）⇄ qwen3.8-omni-flash-realtime。
 *
 * 跟豆包那条（callserver.ts）的分工不同：这里 Qwen 自己就是通话里的「脑子」——全双工地听和说、
 * 判断要不要动手；但动手全部走我们自己的工具（runTool），派活、提醒、查进度都记在我们的账上。
 * 为什么换：豆包端到端按音频输出 300 元/百万 token 计，太贵；Qwen 这条实测每分钟一两分钱。
 *
 * 页面协议和豆包那条完全一样（16k PCM 上来、24k PCM 下去、you/her/clear/hangup 这些事件），页面不用改。
 * 配置在 ~/.config/dongni/bailian.json：{ apiKey, realtimeModel, voice, callEngine }；callEngine 写 "doubao" 就切回豆包。
 */
const CFG = path.join(os.homedir(), ".config", "dongni", "bailian.json");
const URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

type QwenConfig = { apiKey: string; realtimeModel: string; voice: string };

export function qwenCallConfig(): QwenConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(CFG, "utf8")) as Partial<QwenConfig> & { callEngine?: string };
    if (!c.apiKey || c.callEngine === "doubao") return null;
    return { apiKey: c.apiKey, realtimeModel: c.realtimeModel || "qwen3.8-omni-flash-realtime", voice: c.voice || "Serena" };
  } catch {
    return null;
  }
}

/** 电话里能用的工具：费时又出不了声的（画图、拍照、改写长文）不给，免得电话那头干等 */
const CALL_TOOLS = new Set([
  "list_dir",
  "read_file",
  "search_files",
  "recent_files",
  "system_info",
  "set_reminder",
  "list_reminders",
  "cancel_reminder",
  "dispatch_task",
  "dispatch_status",
  "cancel_task",
  "set_city",
  "repair_self",
  "write_file",
]);

const realtimeTools = () =>
  TOOLS.filter((t) => CALL_TOOLS.has(t.function.name)).map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));

const CALL_RULES = `现在你们在打电话。句子短、口语，像真打电话那样自然接话；别长篇大论，别列条目，别念路径和编号。
他插话你就停下来听。
涉及做事的（派活、查进度、设提醒、查电脑、叫停），必须先调用对应的工具，拿到工具的结果再说；工具没调成功就照实说没成，绝不先说「好了」「派出去了」。
转述工具结果只说它原本的意思，不加工：它说「现在没有在跑的活」，就别说成「都跑完了」；不知道的就说不知道。
标着「系统消息」的不是他说的话：那是后台刚发生的事（派出去的活办完了、提醒到点了、他在对话框里打了字）。找个自然的空当用一两句告诉他，接得上刚才的话头，不要说「系统消息」这几个字。`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}……（后面省略）` : s);

export function qwenBridge(page: WebSocket, cfg: QwenConfig, systemRole: () => Promise<string>, isGoodbye: (t: string) => boolean) {
  const tell = (o: unknown) => page.readyState === WebSocket.OPEN && page.send(JSON.stringify(o));
  const up = new WebSocket(`${URL}?model=${encodeURIComponent(cfg.realtimeModel)}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  const send = (o: unknown) => up.readyState === WebSocket.OPEN && up.send(JSON.stringify(o));
  const T0 = Date.now();
  const log = (s: string) => console.log(`[dongni][qwen] +${((Date.now() - T0) / 1000).toFixed(1)}s ${s}`);

  let ready = false;
  let counted = false;
  let responding = false; // 她这一轮在生成/在说
  let userSpeaking = false;
  let herText = ""; // 这一轮她说出口的字（字幕 + 记进对话）
  let herAudioBytes = 0; // 这一轮下发的声音，挂断时按它估「念完」
  let stopAt = 0; // 他说完的时刻，算接话快慢
  let firstAudio = false;
  let odd: Buffer | null = null;
  let byePending = false;
  const tokens = { audioIn: 0, audioOut: 0, textIn: 0, textOut: 0 };
  const pendingNews: string[] = []; // 后台刚发生、要找空当告诉他的事
  let lastSeen = (db().prepare("SELECT MAX(id) m FROM messages").get() as { m: number | null }).m ?? 0;
  const mine = new Set<number>();

  const save = (role: "user" | "assistant", content: string) => {
    const r = db()
      .prepare("INSERT INTO messages(role, content, status, created_at, kind) VALUES(?, ?, 'done', ?, 'call')")
      .run(role, content, Date.now());
    mine.add(Number(r.lastInsertRowid));
    if (role === "user") scheduleExtraction();
  };

  /** 后台的事（派活回来、提醒、他在对话框打的字引出的回复）：塞给她，等空当说 */
  const flushNews = () => {
    if (!pendingNews.length || responding || userSpeaking || !ready) return;
    const news = pendingNews.splice(0).join("\n");
    send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: `（系统消息，不是他说的）刚发生的事：\n${news}` }] },
    });
    send({ type: "response.create" });
  };
  const watcher = setInterval(() => {
    const rows = db()
      .prepare("SELECT id, role, content, kind FROM messages WHERE id > ? AND status = 'done' ORDER BY id")
      .all(lastSeen) as { id: number; role: string; content: string; kind: string }[];
    for (const r of rows) {
      lastSeen = r.id;
      if (mine.has(r.id) || r.kind === "system" || r.kind === "call") continue;
      const t = clip(speakableText(r.content), 400);
      if (!t) continue;
      pendingNews.push(r.role === "user" ? `他在对话框里打字：${t}` : `你在对话框里说了（或后台替你发了）：${t}`);
    }
    flushNews();
  }, 1500);

  // 心跳：页面半开（合盖、切网）时 close 不来，别让「在通话」一直挂着
  let ponged = true;
  const beat = setInterval(() => {
    if (page.readyState !== WebSocket.OPEN) return;
    if (!ponged) return close();
    ponged = false;
    page.ping();
  }, 30_000);
  page.on("pong", () => (ponged = true));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(watcher);
    clearInterval(beat);
    if (counted) callEnded();
    // 单价（北京，元/百万 token）：音频入 6、音频出 12、文本入 1.5、文本出 4.5
    const cost = (tokens.audioIn * 6 + tokens.audioOut * 12 + tokens.textIn * 1.5 + tokens.textOut * 4.5) / 1e6;
    log(`挂断｜用量 音频入 ${tokens.audioIn} 出 ${tokens.audioOut}，文本入 ${tokens.textIn} 出 ${tokens.textOut}｜约 ${cost.toFixed(4)} 元`);
    try {
      up.close();
    } catch {}
    try {
      page.close();
    } catch {}
  };

  const hangupAfterSaid = () => {
    // 她那句道别还在页面上放着：按下发的声音估个时长，放完再挂
    const secs = herAudioBytes / 48000;
    setTimeout(() => {
      tell({ type: "hangup" });
      close();
    }, secs * 1000 + 1500);
  };

  up.on("open", async () => {
    const instructions = `${await systemRole()}\n\n${CALL_RULES}\n\n【你后台的事·实时状态】\n${selfState()}\n${HONESTY}`;
    send({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: cfg.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm24",
        input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
        turn_detection: { type: "server_vad", silence_duration_ms: 600 },
        tools: realtimeTools(),
      },
    });
  });

  up.on("message", async (raw: Buffer) => {
    let e: Record<string, any>;
    try {
      e = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (e.type) {
      case "session.updated":
        if (ready) break;
        ready = true;
        counted = true;
        callStarted();
        log(`接通（${cfg.realtimeModel}，音色 ${cfg.voice}，工具 ${realtimeTools().length} 个）`);
        tell({ type: "ready", voiceprint: false });
        break;
      case "input_audio_buffer.speech_started":
        userSpeaking = true;
        // 他开口了：她要是正在说，马上停（页面清掉没放完的声音），没说出口的不算说过
        if (responding) {
          send({ type: "response.cancel" });
          tell({ type: "clear" });
          log("他插话，停嘴");
        }
        break;
      case "input_audio_buffer.speech_stopped":
        userSpeaking = false;
        stopAt = Date.now();
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(e.transcript ?? "").trim();
        if (!text) break;
        log(`他：${text}`);
        tell({ type: "you", text });
        save("user", text);
        byePending = isGoodbye(text);
        break;
      }
      case "response.created":
        responding = true;
        herText = "";
        herAudioBytes = 0;
        firstAudio = false;
        odd = null;
        break;
      case "response.audio.delta": {
        // 16 位采样两个字节一个：片段切在奇数字节上时把多出来那一个留到下一片，页面才能整片按 Int16 读
        let buf = Buffer.from(String(e.delta), "base64");
        if (odd) buf = Buffer.concat([odd, buf]);
        odd = buf.length % 2 ? buf.subarray(buf.length - 1) : null;
        if (odd) buf = buf.subarray(0, buf.length - 1);
        if (!buf.length) break;
        if (!firstAudio) {
          firstAudio = true;
          if (stopAt) log(`她开口（距他说完 ${Date.now() - stopAt}ms）`);
        }
        herAudioBytes += buf.length;
        if (page.readyState === WebSocket.OPEN) page.send(buf);
        break;
      }
      case "response.audio_transcript.delta":
        herText += String(e.delta ?? "");
        tell({ type: "her", text: herText });
        break;
      case "response.function_call_arguments.done": {
        const name = String(e.name);
        log(`动手：${name} ${String(e.arguments).slice(0, 80)}`);
        const attached: string[] = [];
        const out = await runTool(name, String(e.arguments || "{}"), {
          turnId: `call-${Date.now()}`,
          attach: (md) => attached.push(md),
          see: () => {},
        });
        log(`工具回来：${out.replace(/\s+/g, " ").slice(0, 80)}`);
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: clip(out, 4000) } });
        // 挂上的文件卡片、图片：电话里念不出来，记进对话让他在页面上看
        if (attached.length) save("assistant", attached.join("\n\n"));
        send({ type: "response.create" });
        break;
      }
      case "response.done": {
        responding = false;
        const r = e.response ?? {};
        const u = r.usage ?? {};
        tokens.audioIn += u.input_tokens_details?.audio_tokens ?? 0;
        tokens.textIn += u.input_tokens_details?.text_tokens ?? 0;
        tokens.audioOut += u.output_tokens_details?.audio_tokens ?? 0;
        tokens.textOut += u.output_tokens_details?.text_tokens ?? 0;
        const said = herText.trim();
        if (said) {
          // 被他打断的：只记说出口的那截
          save("assistant", r.status === "cancelled" ? `${said}……` : said);
          log(`她：${said.slice(0, 60)}${r.status === "cancelled" ? "（被打断）" : ""}`);
          if (byePending && r.status !== "cancelled") {
            byePending = false;
            hangupAfterSaid();
          }
        }
        herText = "";
        flushNews();
        break;
      }
      case "error": {
        const msg = JSON.stringify(e.error ?? e).slice(0, 300);
        // 取消一个已经结束的回复之类的小错，不影响通话
        if (/cancel|no active response/i.test(msg)) break;
        console.warn("[dongni][qwen] 报错：", msg);
        tell({ type: "error", message: msg });
        break;
      }
    }
  });
  up.on("unexpected-response", (_q, res) => {
    tell({ type: "error", message: `连不上通义实时语音（HTTP ${res.statusCode}）` });
    close();
  });
  up.on("error", (err) => {
    tell({ type: "error", message: err.message });
    close();
  });
  up.on("close", () => close());

  // 页面送来的是 16k 单声道 16 位 PCM（20ms 一包）：攒到 100ms 再转发，少发点小包
  let chunk: Buffer[] = [];
  let size = 0;
  page.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary || !ready) return; // 文字控制消息（录声纹）这条路暂时不支持
    chunk.push(Buffer.from(data));
    size += data.length;
    if (size >= 3200) {
      send({ type: "input_audio_buffer.append", audio: Buffer.concat(chunk).toString("base64") });
      chunk = [];
      size = 0;
    }
  });
  page.on("close", () => close());
}
