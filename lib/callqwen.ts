import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { cutReply, startReply } from "./chat";
import { db } from "./db";
import { replyMode } from "./llm";
import { callEnded, callStarted, type ReplyEvent, subscribeReplies } from "./presence";
import { speakableText } from "./tts";
import { taskStateLines } from "./tasks";
import { judgeTurn, type TurnIntent } from "./turnjudge";
import {
  ENROLL_SECONDS,
  enrollVoiceprint,
  VOICEPRINT_MAYBE,
  VOICEPRINT_MIN,
  voiceprint,
  voiceprintScore,
  warmVoiceprint,
} from "./voiceprint";

/**
 * 打电话（通义）：页面 ⇄ 这里（本机 3940）⇄ 通义实时识别 + 通义实时合成。
 *
 * 通义只当「耳朵和嘴」：耳朵听你说、判断你说完没、你开口时让她停；嘴用 Serena 把她的话念出来。
 * 「脑子」还是她自己的——跟打字同一条路（startReply），同一份记忆、同样的工具、同样的「说了没做」核对。
 * 之前试过让通义的端到端模型自己当脑子：便宜，但它想到就说，没工具也编「试了，模型请求失败」，管不住。
 *
 * 页面协议跟豆包那条一样（16k PCM 上来、24k PCM 下去、ready/you/her/clear/hangup 这些事件），页面不用改。
 * 配置在 ~/.config/dongni/bailian.json：{ apiKey, voice, callEngine }；callEngine 写 "doubao" 就切回豆包。
 */
const CFG = path.join(os.homedir(), ".config", "dongni", "bailian.json");
const URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const ASR_MODEL = "qwen3-asr-flash-realtime";
const TTS_MODEL = "qwen3-tts-flash-realtime";
const AUTO_ENROLL_SECONDS = 12;
const FRAME = 640; // 页面一包 20ms 的 16k PCM
/** 整句声纹低于这个才当成别人（真人真麦克风分数普遍偏低，0.3 上下的多半还是他） */
const VOICEPRINT_REJECT = 0.2;

export type QwenConfig = { apiKey: string; voice: string };

export function qwenCallConfig(): QwenConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(CFG, "utf8")) as Partial<QwenConfig> & { callEngine?: string };
    if (!c.apiKey || c.callEngine === "doubao") return null;
    return { apiKey: c.apiKey, voice: c.voice || "Serena" };
  } catch {
    return null;
  }
}

/** 不成句的声音（笑、嗯、啊、咳）：识别出来也不当一句话回，免得她对着笑声说「笑啥呀」 */
const NOISE = /^[\s嗯啊哦噢呃额唔哈呵嘿诶欸哎呀嘛吧呢~～。，、,.!！?？…]*$/;

export function qwenBridge(page: WebSocket, cfg: QwenConfig, isGoodbye: (t: string) => boolean) {
  const tell = (o: unknown) => page.readyState === WebSocket.OPEN && page.send(JSON.stringify(o));
  const open = (model: string) => new WebSocket(`${URL}?model=${model}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  let T0 = Date.now();
  const log = (s: string) => console.log(`[dongni][qwen] +${Date.now() - T0}ms ${s}`);
  warmVoiceprint();

  // ─────────── 嘴：每段话一条合成连接；提前备好一条，开口不用等建连 ───────────
  let chars = 0; // 合成计费字符（汉字算 2 个）
  const ttsReady = () =>
    new Promise<WebSocket | null>((resolve) => {
      const ws = open(TTS_MODEL);
      const fail = () => resolve(null);
      ws.once("error", fail);
      ws.once("unexpected-response", fail);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: { voice: cfg.voice, mode: "server_commit", language_type: "Chinese", response_format: "pcm", sample_rate: 24000 },
          }),
        ),
      );
      const onFirst = (raw: Buffer) => {
        const e = JSON.parse(raw.toString());
        if (e.type === "session.updated") {
          ws.off("message", onFirst);
          resolve(ws);
        } else if (e.type === "error") resolve(null);
      };
      ws.on("message", onFirst);
    });
  let spare: Promise<WebSocket | null> = ttsReady();
  const takeTts = () => {
    const got = spare;
    spare = ttsReady();
    return got;
  };

  let turn = 0; // 他插话一次就 +1：上一轮还没念的不再念
  /** 把她的话一句句送去念；声音都送完后回调 onDone（给出总时长，好估页面什么时候放完） */
  const speaker = (myTurn: number, onSaid: (t: string) => void, onDone: (secs: number) => void) => {
    let started = false;
    let pending = "";
    let finished = false;
    const lines: string[] = [];
    let ws: WebSocket | null = null;
    let wsP: Promise<WebSocket | null> | null = null;
    let bytes = 0;
    let odd: Buffer | null = null;
    let reported = false;
    const done = () => {
      if (reported) return;
      reported = true;
      onDone(bytes / 48000);
    };
    const flush = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      while (lines.length) ws.send(JSON.stringify({ type: "input_text_buffer.append", text: lines.shift() }));
      if (finished) {
        ws.send(JSON.stringify({ type: "input_text_buffer.commit" }));
        ws.send(JSON.stringify({ type: "session.finish" }));
      }
    };
    const connect = () => {
      wsP = takeTts();
      void wsP.then((got) => {
        if (!got || myTurn !== turn) {
          got?.close();
          return done();
        }
        ws = got;
        got.on("message", (raw: Buffer) => {
          const e = JSON.parse(raw.toString());
          if (e.type === "response.audio.delta") {
            if (myTurn !== turn) return;
            // 两个字节一个采样：切在奇数字节上的那一个留给下一片
            let buf = Buffer.from(String(e.delta), "base64");
            if (odd) buf = Buffer.concat([odd, buf]);
            odd = buf.length % 2 ? buf.subarray(buf.length - 1) : null;
            if (odd) buf = buf.subarray(0, buf.length - 1);
            if (!buf.length) return;
            if (!bytes) log("开始出声");
            bytes += buf.length;
            if (page.readyState === WebSocket.OPEN) page.send(buf);
          } else if (e.type === "response.done") {
            chars += Number(e.response?.usage?.characters ?? 0);
          } else if (e.type === "session.finished") {
            got.close();
            done();
          } else if (e.type === "error") {
            console.warn("[dongni][qwen] 合成报错：", JSON.stringify(e.error).slice(0, 200));
          }
        });
        got.on("close", done);
        flush();
      });
    };
    const send = (content: string) => {
      if (myTurn !== turn) return;
      if (!started) {
        started = true;
        log(`送去念第一句：${content.slice(0, 20)}`);
        connect();
      }
      lines.push(content);
      onSaid(content);
      flush();
    };
    return {
      push(delta: string) {
        if (finished) return;
        pending += delta;
        // 说完一句就送；第一句凑够几个字碰到逗号就先送，早点出声
        const m = pending.match(/^[\s\S]*[。！？!?～\n]/) ?? (!started && pending.length >= 8 ? pending.match(/^[\s\S]*[，,、]/) : null);
        if (m) {
          const said = speakableText(m[0]);
          pending = pending.slice(m[0].length);
          if (said) send(said);
        }
      },
      end() {
        if (finished) return;
        const said = speakableText(pending);
        pending = "";
        if (said) send(said);
        finished = true;
        if (!started) return done();
        flush();
      },
      stop() {
        finished = true;
        lines.length = 0;
        try {
          ws?.close();
        } catch {}
        void wsP?.then((w) => w?.close());
      },
    };
  };

  // ─────────── 她这一句：想完 + 念完才算完 ───────────
  type Speaking = {
    id: number;
    say: ReturnType<typeof speaker>;
    spoken: string;
    text: string;
    genDone: boolean;
    playEnd?: NodeJS.Timeout;
  };
  let current: Speaking | null = null;
  const extras: string[] = [];
  let extraBusy = false;
  const generated = new Set<number>();

  /** 声音送完了：按时长估页面什么时候放完（页面会先垫 0.1 秒） */
  const afterPlay = (secs: number, then: () => void) => setTimeout(then, secs * 1000 + 300);

  const speakExtras = () => {
    if (current || extraBusy || !extras.length) return;
    extraBusy = true;
    const say = speaker(turn, () => {}, (secs) =>
      afterPlay(secs, () => {
        extraBusy = false;
        speakExtras();
      }),
    );
    say.push(extras.splice(0).join("\n") + "\n");
    say.end();
  };

  // 他说了道别的话：她那句回完、放完，再等一会儿挂
  let byePending = false;
  let byeLimit: NodeJS.Timeout | undefined;
  const cancelBye = () => {
    byePending = false;
    clearTimeout(byeLimit);
  };
  const endBye = () => {
    if (!byePending) return;
    cancelBye();
    log("道过别了，挂断");
    tell({ type: "hangup" });
    close();
  };

  const finishSpeaking = (me: Speaking) => {
    if (current !== me) return;
    herLast = me.text;
    current = null;
    if (byePending) setTimeout(endBye, 1200);
    speakExtras();
  };

  const onReply = (e: ReplyEvent) => {
    if (e.type === "start") {
      generated.add(e.assistantId);
      const me: Speaking = {
        id: e.assistantId,
        say: speaker(
          turn,
          (t) => (me.spoken += t),
          (secs) => {
            me.playEnd = afterPlay(secs, () => finishSpeaking(me));
          },
        ),
        spoken: "",
        text: "",
        genDone: false,
      };
      current = me;
      return;
    }
    if (!current || e.assistantId !== current.id) return; // 接通前开始的、被打断的，都不念
    if (e.type === "delta") {
      if (!current.text) log("第一个字");
      current.say.push(e.text);
      current.text += e.text;
      tell({ type: "her", text: current.text });
    } else if (e.type === "done") {
      current.genDone = true;
      current.say.end();
    }
  };

  /**
   * 他一开口：她正在出声就先停嘴（页面清掉没放完的声音、这一句不再往下念）。
   * 只停声音，不取消回复——是不是他、是不是一句话还没定；她还没开口（还在想、在交活）就什么都不动。
   * 2026-11-02：一段「嘟嘟嘟」的杂音把她还没开口的回复整条取消了，她就一直不吭声。
   */
  const hush = () => {
    const talking = (current && current.spoken) || extraBusy;
    if (!talking) return;
    tell({ type: "clear" });
    turn++;
    current?.say.stop();
  };

  /** 他插话（认过是他、说了一句完整的话）：她停嘴，正在想的那句也停，只留说出口的 */
  const interrupt = () => {
    cancelBye();
    tell({ type: "clear" });
    turn++;
    if (current) {
      cutReply(current.id, current.spoken);
      current.say.stop();
      clearTimeout(current.playEnd);
      current = null;
    }
    extras.length = 0;
  };

  /** 不经过脑子、直接写进对话的话（提醒到点、派活回来、照片拍好）：电话里也说一声 */
  let lastSeen = (db().prepare("SELECT MAX(id) m FROM messages").get() as { m: number | null }).m ?? 0;
  const watchDirect = () => {
    const rows = db()
      .prepare("SELECT id, content, kind FROM messages WHERE id > ? AND role = 'assistant' AND status = 'done' ORDER BY id")
      .all(lastSeen) as { id: number; content: string; kind: string }[];
    for (const r of rows) {
      lastSeen = r.id;
      if (generated.has(r.id) || r.kind === "system" || r.kind === "call") continue;
      const t = speakableText(r.content);
      if (t) extras.push(t);
    }
    speakExtras();
  };

  /**
   * 他说完一句：先交给判断层（lib/turnjudge.ts）看一眼——说完了没、要什么——再照结论办。
   * - 没说完：最多再等 2.5 秒，他接着说就跟前面合成一句再判断；
   * - 说完了：马上交给她自己的脑子回，不再固定干等；
   * - 要挂电话（语义判断，「你先挂吧」也算）：她回完这句、声音放完就真挂；
   * - 让她别说了：停嘴，不回；不是在跟她说话：不理。
   * 判断层出错/超时：当他说完了照常回，挂电话退回触发词判断。
   */
  let asking = "";
  let askSeq = 0;
  let waitTimer: NodeJS.Timeout | undefined;
  let herLast = "";
  const WAIT_MORE_MS = 2500;
  const recentLines = () =>
    (db().prepare("SELECT role, content FROM messages WHERE status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT 6").all() as {
      role: string;
      content: string;
    }[])
      .reverse()
      .map((m) => `${m.role === "user" ? "他" : "她"}：${speakableText(m.content).slice(0, 100)}`)
      .join("\n");
  const answer = async (text: string) => {
    clearTimeout(waitTimer);
    asking = asking ? `${asking} ${text}` : text;
    const mine = ++askSeq;
    const heard = asking;
    const t0 = Date.now();
    const j = await judgeTurn({ heard, herLast: current?.text || herLast, recent: recentLines(), tasks: taskStateLines() });
    if (mine !== askSeq) return; // 判断的时候他又说了一句：以新的那次为准
    log(`判断（${Date.now() - t0}ms）：${j ? `${j.complete ? "说完了" : "没说完"}，${j.intent}` : "没判断出来，照常回"}｜${heard.slice(0, 30)}`);
    const intent = j?.intent ?? (isGoodbye(heard) ? "end_call" : "chat");
    if (intent === "noise") {
      asking = "";
      return;
    }
    if (intent === "stop_talking") {
      asking = "";
      interrupt();
      return;
    }
    if (j && !j.complete) {
      waitTimer = setTimeout(() => sendAsk(intent), WAIT_MORE_MS);
      return;
    }
    sendAsk(intent);
  };
  const holdAsk = () => clearTimeout(waitTimer);
  const resumeAsk = () => {
    if (!asking) return;
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => sendAsk("chat"), WAIT_MORE_MS);
  };
  const sendAsk = (intent: TurnIntent) => {
    clearTimeout(waitTimer);
    const text = asking;
    asking = "";
    if (!text) return;
    interrupt(); // 他确实说了一句要她接的话：她没说完的那句放下，回这句
    if (intent === "end_call") {
      byePending = true; // 她回完这句、声音放完就挂（见 finishSpeaking）
      clearTimeout(byeLimit);
      byeLimit = setTimeout(endBye, 25_000);
    } else cancelBye();
    replyMode.run({ fast: true }, () =>
      startReply(`call-${crypto.randomUUID()}`, text, (e) => {
        if (e.type !== "meta") return;
        db().prepare("UPDATE messages SET kind = 'call' WHERE id IN (?, ?)").run(e.userId, e.assistantId);
      }),
    );
  };

  // ─────────── 耳朵：一整通电话一条识别连接 ───────────
  const asr = open(ASR_MODEL);
  let ready = false;
  let counted = false;
  let unsubscribe = () => {};
  let watcher: NodeJS.Timeout | undefined;
  const pre: Buffer[] = []; // 最近半秒的声音：识别报「开口」总晚一点，往前补
  let utter: Buffer[] | null = null; // 这一句攒下的声音（认声纹）
  let verdict: boolean | null = null;
  let checking = false;
  let enrolling: Buffer[] | null = null;
  let partial = "";
  let cutThisTurn = false; // 这一句已经让她停过嘴了

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
    clearInterval(beat);
    clearInterval(watcher);
    clearTimeout(waitTimer);
    unsubscribe();
    cancelBye();
    current?.say.stop();
    if (counted) callEnded();
    // 识别 0.00033 元/秒，合成 1 元/万字符（北京）
    const secs = (Date.now() - startedAt) / 1000;
    log(`挂断｜通话 ${Math.round(secs)} 秒，合成 ${chars} 字符｜约 ${(secs * 0.00033 + chars / 10000).toFixed(4)} 元`);
    void spare.then((w) => w?.close());
    try {
      asr.close();
    } catch {}
    try {
      page.close();
    } catch {}
  };
  const startedAt = Date.now();

  asr.on("open", () =>
    asr.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "pcm",
          sample_rate: 16000,
          input_audio_transcription: { language: "zh" },
          turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: 600 },
        },
      }),
    ),
  );

  /** 他开口一秒多了：认一认是不是他，是他才打断她 */
  const checkEarly = async (buf: Buffer[]) => {
    checking = true;
    try {
      const score = await voiceprintScore(Buffer.concat(buf));
      if (utter !== buf || score === null) return;
      verdict = score >= VOICEPRINT_MAYBE;
      log(`声纹 开头 ${score.toFixed(2)} ${score >= VOICEPRINT_MIN ? "是他" : verdict ? "大概是他" : "不像他"}`);
      if (verdict) {
        if (!cutThisTurn) {
          cutThisTurn = true;
          hush();
        }
        if (partial) tell({ type: "you", text: partial });
      }
    } catch {
      verdict = true; // 认不了就别把他拦在外面
    } finally {
      checking = false;
    }
  };

  const autoBuf: Buffer[] = [];
  let autoBusy = false;
  const autoEnroll = async (heard: Buffer[]) => {
    if (autoBusy) return;
    autoBuf.push(Buffer.concat(heard));
    const all = Buffer.concat(autoBuf);
    if (all.length < AUTO_ENROLL_SECONDS * 32000) return;
    autoBusy = true;
    const r = await enrollVoiceprint(all).catch((e) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
    log(`声纹自动录入 ${r.ok ? "好了" : `没成：${r.message}`}`);
    autoBuf.length = 0;
    if (r.ok) tell({ type: "enrolled" });
    autoBusy = false;
  };

  asr.on("message", async (raw: Buffer) => {
    const e = JSON.parse(raw.toString());
    switch (e.type) {
      case "session.updated":
        if (ready) break;
        ready = true;
        counted = true;
        callStarted();
        unsubscribe = subscribeReplies(onReply);
        watcher = setInterval(watchDirect, 1500);
        log(`接通（识别 ${ASR_MODEL}，合成 ${TTS_MODEL}，音色 ${cfg.voice}）`);
        tell({ type: "ready", voiceprint: !!voiceprint() });
        break;
      case "input_audio_buffer.speech_started":
        holdAsk(); // 他又开口了：前面那句先别交，等他说完一起
        partial = "";
        cutThisTurn = false;
        if (!voiceprint()) {
          utter = []; // 还没声纹：这句攒下来拿去自动录；等识别出成句的话再打断，笑一声、咳一下不算
          break;
        }
        utter = [...pre]; // 录过声纹：先认一认是不是他，是他才打断（见下面收音频的地方）
        verdict = null;
        break;
      case "input_audio_buffer.speech_stopped":
        T0 = Date.now();
        break;
      case "conversation.item.input_audio_transcription.text":
        partial = `${e.text ?? ""}${e.stash ?? ""}`;
        // 识别出第一个像样的字就让她停嘴（开口后零点几秒），不等声纹那 1.2 秒；
        // 声纹只决定这句要不要回，不决定她要不要先闭嘴。开头已经认出不是他的除外。
        if (!cutThisTurn && verdict !== false && !NOISE.test(partial)) {
          cutThisTurn = true;
          hush();
        }
        if (partial && (verdict === true || !voiceprint())) tell({ type: "you", text: partial });
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(e.transcript ?? "").trim();
        const heard = utter;
        utter = null;
        partial = "";
        if (!text || NOISE.test(text)) {
          resumeAsk();
          verdict = null;
          if (text) log(`不成句，不接：${text}`);
          break;
        }
        if (heard && !voiceprint()) {
          hush();
          if (text.length >= 2) void autoEnroll(heard);
          tell({ type: "you", text });
        } else if (heard && voiceprint()) {
          // 整句再认一遍。开头那一秒已经认出是他，就不再推翻；只有分数明显低（真是别人/电视声）才不理。
          // 以前卡在及格线上一点点就整句丢掉，页面上什么都不显示，他以为她卡死了。
          const score = await voiceprintScore(Buffer.concat(heard)).catch(() => null);
          const ok = score === null || score >= VOICEPRINT_MIN;
          const maybe = !ok && (verdict === true || (score ?? 0) >= VOICEPRINT_REJECT);
          log(`声纹 整句 ${score?.toFixed(2)} ${ok ? "是他" : maybe ? "大概是他，先接着" : "不是他，不理"}：${text.slice(0, 20)}`);
          if (!ok && !maybe) {
            resumeAsk();
            tell({ type: "you", text: `${text}（没认出是你的声音，没接）`, unsure: true });
            verdict = null;
            break;
          }
          hush();
          tell({ type: "you", text, unsure: maybe });
        } else {
          hush();
          tell({ type: "you", text });
        }
        verdict = null;
        log(`他：${text}`);
        answer(text);
        break;
      }
      case "error":
        console.warn("[dongni][qwen] 识别报错：", JSON.stringify(e.error).slice(0, 200));
        break;
    }
  });
  asr.on("unexpected-response", (_q, res) => {
    tell({ type: "error", message: `连不上通义语音识别（HTTP ${res.statusCode}）` });
    close();
  });
  asr.on("error", (err) => {
    tell({ type: "error", message: err.message });
    close();
  });
  // 被对面断开（欠费、key 失效之类）：把原因告诉页面，别一声不吭地挂掉
  asr.on("close", (code, reason) => {
    if (closed) return;
    const why = reason.toString();
    if (why) {
      console.warn(`[dongni][qwen] 识别连接被断开（${code}）：${why}`);
      tell({
        type: "error",
        message: /good standing|arrear|欠费|balance/i.test(why) ? "通义账户欠费了，阿里云把语音服务停了，充值后再打" : `通义语音断开了：${why.slice(0, 80)}`,
      });
    }
    close();
  });

  // 页面传来的 16k PCM：攒 100ms 转给识别；文字消息是控制（手动录声纹）
  let chunk: Buffer[] = [];
  let size = 0;
  const ENROLL_BYTES = ENROLL_SECONDS * 32000;
  page.on("message", async (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      try {
        if (JSON.parse(Buffer.from(data).toString()).type === "enroll") {
          enrolling = [];
          utter = null;
          verdict = null;
        }
      } catch {}
      return;
    }
    if (!ready || asr.readyState !== WebSocket.OPEN) return;
    let pcm = Buffer.from(data);
    if (enrolling) {
      enrolling.push(pcm);
      const got = enrolling.length * FRAME;
      if (enrolling.length % 25 === 0) tell({ type: "enroll", progress: Math.min(1, got / ENROLL_BYTES) });
      if (got >= ENROLL_BYTES) {
        const all = Buffer.concat(enrolling);
        enrolling = null;
        const r = await enrollVoiceprint(all).catch((e) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
        tell(r.ok ? { type: "enrolled" } : { type: "enroll-failed", message: r.message });
      }
      pcm = Buffer.alloc(pcm.length); // 录的时候别让她听见
    } else {
      pre.push(pcm);
      if (pre.length > 25) pre.shift();
      if (utter) {
        utter.push(pcm);
        if (verdict === null && !checking && utter.length >= 60 && voiceprint()) void checkEarly(utter);
      }
    }
    chunk.push(pcm);
    size += pcm.length;
    if (size >= 3200) {
      asr.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.concat(chunk).toString("base64") }));
      chunk = [];
      size = 0;
    }
  });
  page.on("close", () => close());
}
