import "server-only";
import crypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { db, type MessageRow } from "./db";
import { stripImageMarkdown } from "./images";
import { activeMemories, getProfile } from "./memory";
import { PERSONA } from "./persona";
import { todayMe } from "./todayme";
import { voiceConfig } from "./voiceconfig";
import { cutReply, startReply } from "./chat";
import { replyMode } from "./llm";
import { callEnded, callStarted, type ReplyEvent, subscribeReplies } from "./presence";
import { speakableText } from "./tts";
import {
  ENROLL_SECONDS,
  enrollVoiceprint,
  VOICEPRINT_MAYBE,
  VOICEPRINT_MIN,
  voiceprint,
  voiceprintScore,
  warmVoiceprint,
} from "./voiceprint";
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
const PORT = Number(process.env.DONGNI_CALL_PORT) || 3940;
/** 没录过声纹时，攒够这么多秒他的话就自动录 */
const AUTO_ENROLL_SECONDS = 12; // 页面按「网页端口 + 1」来连
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

/**
 * 他是不是在道别：拜拜、再见、先这样、我挂了这类。
 * 问句不算——「拜拜是什么意思」「挂了怎么说」是在问话，不是要挂电话。
 * 宁可漏判也别误挂：带问法、问号、或者话还长着（还在说事）的，都不算。
 */
const BYE =
  /(拜拜|掰掰|再见|再聊|回头聊|改天聊|下次聊|先这样|先这么着|不聊了|先不聊了|我挂了|挂了啊|挂了|我去睡了|先睡了|我睡了|晚安|我走了|先走了|就这样吧)/g;
const ASK = /(什么|啥|怎么|为什么|为啥|意思|咋|哪|谁|多少|多久|能不能|是不是|可不可以|要不要|有没有)/;
function isGoodbye(raw: string) {
  const t = raw.replace(/\s+/g, "");
  if (t.length < 2 || t.length > 30) return false;
  if (/[?？]/.test(t) || ASK.test(t)) return false;
  // 道别语得在话的末尾（后面只剩语气词）：说事说了一半不像要走
  for (const m of t.matchAll(BYE)) {
    const rest = t.slice(m.index! + m[0].length).replace(/[了啊啦哦呀哈嘛呗呢吧诶欸~～。，、,.!！…]/g, "");
    if (rest.length <= 4) return true;
  }
  return false;
}


function bridge(page: WebSocket) {
  const cfg = voiceConfig();
  const tell = (o: unknown) => page.readyState === WebSocket.OPEN && page.send(JSON.stringify(o));
  if (!cfg.apiKey) {
    tell({ type: "error", message: "还没配豆包的 key" });
    return page.close();
  }
  const sid = crypto.randomUUID();
  warmVoiceprint();
  let ready = false;
  let userText = "";
  let playing = ""; // 当前这句是谁的声音：chat_tts_text 是她的脑子说的，其他是豆包自己的，不播
  let turn = 0; // 第几轮回复；他插话后，上一轮剩下的话就别再送去念了
  // 声纹：pre 是最近半秒的声音（豆包报「开口」总晚一点，往前补上）；utter 是这一句攒下的声音
  const pre: Buffer[] = [];
  let utter: Buffer[] | null = null;
  let verdict: boolean | null = null; // 开头那一秒认出来的：是他 / 不是他 / 还没认
  let checking = false;
  let enrolling: Buffer[] | null = null; // 正在录声纹：这段时间的声音不给豆包
  /**
   * 豆包有两种「照我给的字念」：
   * - ChatTTSText（500）：流式、最快，但只能用来回答他刚在电话里说的那句（收到 459 之后）
   * - SayHello（300）：任何时候都能念，但一次一整段，而且新的一段会顶掉还没念完的——所以排队，念完（359）再送下一段
   * 电话里问的走前者；打字引出来的回复、提醒、照片拍好了这些走后者。
   */
  // 排队的每一段带着自己的「已念」回调：真送去念了才算她说出口，还在队里的被打断就不算
  const hello = { queue: [] as { content: string; onSaid: (t: string) => void }[], busy: false, reply: "", timer: undefined as NodeJS.Timeout | undefined };
  const flushHello = () => {
    if (hello.busy || !hello.queue.length || up.readyState !== WebSocket.OPEN) return;
    const batch = hello.queue.splice(0);
    const content = batch.map((b) => b.content).join("");
    hello.busy = true;
    up.send(frame(300, { content }, sid));
    batch.forEach((b) => b.onSaid(b.content));
    // 万一等不到「念完了」，按字数估个时长兜底，别把后面的话卡死
    clearTimeout(hello.timer);
    hello.timer = setTimeout(() => {
      hello.busy = false;
      flushHello();
    }, 4000 + content.length * 300);
  };
  const helloDone = () => {
    clearTimeout(hello.timer);
    hello.busy = false;
    hello.reply = "";
    flushHello();
    maybeFinished();
  };

  /** 把她的话一句句送去念；viaQuery：是不是在回答他电话里刚说的那句。onSaid 记下真送出去念的 */
  const speaker = (myTurn: number, viaQuery: boolean, onSaid: (t: string) => void = () => {}) => {
    let started = false;
    let pending = "";
    let finished = false;
    const send = (content: string, end: boolean) => {
      if (myTurn !== turn || up.readyState !== WebSocket.OPEN) return;
      if (!started) console.log(`[dongni][call] +${Date.now() - T0}ms 送出第一句：${content.slice(0, 20)}`);
      if (viaQuery) {
        up.send(frame(500, { start: !started, content, end }, sid));
        if (content) onSaid(content);
      } else if (content) {
        hello.queue.push({ content, onSaid });
        flushHello();
      }
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

  /**
   * 一条路：她的每一句回复都从 presence 广播出来，电话这头订阅着就念——
   * 不管这句是你在电话里说的、还是你在对话框里打的字引出来的。回复本来就排着队一句句来，这里同一时间只念一句。
   */
  // current 一直留到这句「念完」为止，不是「想完」——字生成得比念得快，念到一半他插话也要能截住
  type Speaking = {
    id: number;
    say: ReturnType<typeof speaker>;
    via: boolean;
    spoken: string;
    text: string;
    filler: boolean;
    genDone: boolean;
    replyId: string; // 豆包那边这段声音的编号（ChatTTSText 那条路用，等它念完）
    ttsDone: boolean;
    lastDelta: number; // 上一次有新字的时间：长时间没动静就往回垫一句
    fillers: number;
    stall?: NodeJS.Timeout;
    timer?: NodeJS.Timeout;
  };
  let current: Speaking | null = null;
  const callReplies = new Set<number>(); // 回答他电话里那句话的回复
  const generated = new Set<number>(); // 经过脑子生成的回复；其他直接写进对话的（提醒、照片、改好了）另外念
  const extras: string[] = [];
  const speakExtras = () => {
    while (!current && extras.length) {
      const say = speaker(turn, false);
      say.push(extras.shift()! + "\n");
      say.end();
    }
  };
  /**
   * 他说了道别的话：先让她正常回一句（该说的都说完），那句真念完了再等一会儿，
   * 这头自己挂断，不用等他先挂。他要是又接着说别的，就把这次挂断撤掉。
   */
  let byePending = false;
  let byeLimit: NodeJS.Timeout | undefined; // 兜底：她那句一直没念完，也别把电话晾着
  let byeTimer: NodeJS.Timeout | undefined; // 她念完了，隔一会儿挂
  const cancelBye = () => {
    byePending = false;
    clearTimeout(byeLimit);
    clearTimeout(byeTimer);
    byeLimit = byeTimer = undefined;
  };
  const endBye = () => {
    if (!byePending) return;
    cancelBye();
    console.log(`[dongni][call] +${Date.now() - T0}ms 道过别了，挂断`);
    tell({ type: "hangup" });
    close();
  };
  const armBye = () => {
    cancelBye();
    byePending = true;
    byeLimit = setTimeout(endBye, 25000);
  };
  /** 她那句道别念完了：再留一点余量，然后挂 */
  const byeWhenSaid = () => {
    if (!byePending) return;
    clearTimeout(byeLimit);
    byeLimit = undefined;
    byeTimer = setTimeout(endBye, 1500);
  };
  const onReply = (e: ReplyEvent) => {
    if (e.type === "start") {
      generated.add(e.assistantId);
      const via = callReplies.has(e.assistantId);
      const me: Speaking = {
        id: e.assistantId,
        say: speaker(turn, via, (t) => (me.spoken += t)),
        via,
        spoken: "",
        text: "",
        filler: false,
        genDone: false,
        replyId: "",
        ttsDone: false,
        lastDelta: Date.now(),
        fillers: 0,
      };
      // 生成卡住（模型/工具半天不回字）时：这条 500 流会空着不吐字，豆包十几分钟就判「异常静音」，
      // 而 current 一直占着，提醒、改好了这些全排不出去——通着电话却像断了。所以每隔一会儿垫一句。
      me.stall = setInterval(() => {
        if (current !== me || me.genDone) {
          clearInterval(me.stall);
          return;
        }
        if (Date.now() - me.lastDelta < 20_000 || me.fillers >= 6) return;
        const lines = ["嗯……这个我得想一下，", "稍等啊，我这边还在弄，", "别急，我还没弄完，", "马上，再给我一会儿，"];
        me.fillers++;
        me.lastDelta = Date.now();
        const line = lines[(me.fillers - 1) % lines.length];
        console.log(`[dongni][call] +${Date.now() - T0}ms 生成卡了 ${me.fillers} 次，先垫一句：${line}`);
        me.say.push(line + "\n");
        tell({ type: "her", text: `${me.text}${line}` });
      }, 5000);
      if (current) clearTimeout(current.timer);
      current = me;
      return;
    }
    if (!current || e.assistantId !== current.id) return; // 接通前就开始的、被打断的，都不念
    if (e.type === "delta") {
      if (!current.text) console.log(`[dongni][call] +${Date.now() - T0}ms 第一个字`);
      current.lastDelta = Date.now();
      current.say.push(e.text);
      current.text += e.text;
      tell({ type: "her", text: current.text });
    } else if (e.type === "mood" && (e.mood === "run" || e.mood === "draw") && !current.text && !current.filler) {
      // 要去干活了（查电脑、写文件、画画）还一个字没说：先应一声，别让电话那头干等着
      current.filler = true;
      const lines = e.mood === "draw" ? ["好，我画一下，等我会儿～", "行，我这就画，稍等哦"] : ["好，我弄一下，等我一会儿～", "行，我去看看，马上", "嗯嗯，我来弄，稍等哈"];
      current.say.push(lines[Math.floor(Math.random() * lines.length)] + "\n");
    } else if (e.type === "reset") {
      // 调工具前的铺垫话（「我去写一下」）在电话里留着——已经念出去了
    } else if (e.type === "done") {
      current.say.end();
      current.genDone = true;
      // 兜底：等不到「念完」的信号，按字数估个时长就当念完了
      const me = current;
      me.timer = setTimeout(() => finishSpeaking(me), 5000 + me.spoken.length * 300);
      maybeFinished();
    }
  };
  const finishSpeaking = (me: Speaking) => {
    if (current !== me) return;
    clearTimeout(me.timer);
    clearInterval(me.stall);
    current = null;
    speakExtras();
  };
  /** 这句想完了、也念完了：放下，接着念排着的（提醒、照片…） */
  const maybeFinished = () => {
    const c = current;
    if (!c || !c.genDone) return;
    const played = !c.spoken || (c.via ? c.ttsDone : !hello.busy && !hello.queue.length);
    if (played) {
      finishSpeaking(c);
      if (!current) byeWhenSaid();
    }
  };
  /** 他插话（认过是他）：她停嘴，正在想的那句也停，只留说出口的 */
  const interrupt = () => {
    cancelBye(); // 他又开口了，那就不急着挂
    tell({ type: "clear" });
    turn++;
    if (current) {
      cutReply(current.id, current.spoken);
      clearTimeout(current.timer);
      clearInterval(current.stall);
      current = null;
    }
    extras.length = 0;
    hello.queue.length = 0;
    helloDone();
  };
  /** 不经过脑子、直接写进对话的话（提醒到点、照片拍好、改好了…）：电话里也说一声 */
  let lastSeen = 0;
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
  let unsubscribe = () => {};
  let watcher: NodeJS.Timeout | undefined;
  let counted = false;

  /**
   * 心跳：页面合盖、切网、Chrome 崩了，WebSocket 可能停在「半开」——close 事件迟迟不来，
   * calls 就永远减不掉：她以为一直在通话（主动消息全静音、改完自己无限等、说话还切成电话腔）。
   * 30 秒 ping 一次，两轮没回就当作挂了。
   */
  let ponged = true;
  const beat = setInterval(() => {
    if (page.readyState !== WebSocket.OPEN) return;
    if (!ponged) {
      console.log("[dongni][call] 页面一分钟没回心跳，当作挂断");
      close();
      return;
    }
    ponged = false;
    page.ping();
  }, 30_000);
  page.on("pong", () => {
    ponged = true;
  });

  /** 你这句说完了：交给她自己的脑子回（和打字是同一条路，念出来交给上面的订阅） */
  const answer = (text: string) => {
    replyMode.run({ fast: true }, () =>
      startReply(`call-${crypto.randomUUID()}`, text, (e) => {
        // 通话里说的话也是聊天记录，只是标一下来自电话
        if (e.type !== "meta") return;
        callReplies.add(e.assistantId);
        db().prepare("UPDATE messages SET kind = 'call' WHERE id IN (?, ?)").run(e.userId, e.assistantId);
      }),
    );
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
    clearInterval(beat);
    unsubscribe();
    unsubscribe = () => {};
    clearInterval(watcher);
    clearTimeout(hello.timer);
    cancelBye();
    if (counted) {
      counted = false;
      callEnded();
    }
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
      // 「异常静音」不是致命错误：两个人都安静几分钟，豆包就会回这个；以前一律 close()，
      // 结果聊到一半静一会儿整通电话就断了（logs/server.log 里那次静了 5 分钟）。接着用就行。
      if (/silence/i.test(JSON.stringify(m.error))) {
        console.warn("[dongni] 电话那头说「异常静音」，忽略继续：", m.error);
        return;
      }
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
        tell({ type: "ready", voiceprint: !!voiceprint() });
        callStarted();
        counted = true;
        lastSeen = (db().prepare("SELECT MAX(id) m FROM messages").get() as { m: number | null }).m ?? 0;
        unsubscribe = subscribeReplies(onReply);
        watcher = setInterval(watchDirect, 1500);
        break;
      case 450: // 有人开口了：她要是正在说，马上停；上一轮还没念的也不念了
        if (!voiceprint()) {
          interrupt();
          utter = []; // 还没声纹：这句攒下来拿去自动录（见 459）；不用 pre——那是他开口前的声音，多半是她的尾音
          break;
        }
        // 录过声纹：先攒一秒多的声音认一认是不是他，是他才打断（见下面 page.on("message")）
        utter = [...pre];
        verdict = null;
        break;
      case 451: {
        const r = json(m.payload) as { results?: { text?: string; is_interim?: boolean }[] };
        const t = r.results?.[0]?.text ?? "";
        if (t) {
          userText = t;
          // 录过声纹：认出是他之前不上字幕，别人的话不出现
          if (verdict === true || !voiceprint()) tell({ type: "you", text: t });
        }
        break;
      }
      case 459: {
        // 这句说完了：是他说的，交给她自己的脑子
        T0 = Date.now();
        const text = userText.trim();
        userText = "";
        const heard = utter;
        utter = null;
        if (heard && !voiceprint() && text.length >= 2) autoEnroll(heard);
        else if (heard && voiceprint()) {
          // 整句再认一遍（比开头那一秒准）；真杂音才当没听见
          const score = await voiceprintScore(Buffer.concat(heard)).catch(() => null);
          const ok = score === null || score >= VOICEPRINT_MIN;
          const maybe = !ok && (score ?? 0) >= VOICEPRINT_MAYBE;
          console.log(
            `[dongni][call] 声纹 整句 ${score?.toFixed(2)} ${
              ok ? "是他" : maybe ? "大概是他，先接着" : "不是他，不理"
            }：${text.slice(0, 20)}`,
          );
          if (!ok && !maybe) {
            verdict = null;
            break;
          }
          if (verdict !== true) interrupt();
          if (verdict !== true && text) tell({ type: "you", text, unsure: maybe });
        }
        verdict = null;
        console.log(`[dongni][call] 459 说完`);
        if (text) {
          if (isGoodbye(text)) armBye();
          else cancelBye();
          answer(text);
        }
        break;
      }
      case 350: // 新的一句开始念：记下是谁的
        playing = (json(m.payload).tts_type as string) ?? "";
        // 记下这段 SayHello 是哪一条，念完（359）时只认它，别被豆包自己那条（不播的）的结束信号骗了
        if (playing === "chat_tts_text") {
          const rid = String(json(m.payload).reply_id ?? "");
          if (hello.busy && !hello.reply) hello.reply = rid;
          else if (current?.via && !current.replyId) current.replyId = rid;
        }
        console.log(`[dongni][call] +${Date.now() - T0}ms 开始念 ${playing}`);
        break;
      case 352: // 只放她自己脑子说的那些（豆包自己生成的回复不播）
        if (playing === "chat_tts_text" && page.readyState === WebSocket.OPEN && m.payload.length) page.send(m.payload);
        break;
      case 359: // 一段念完了：排着队的下一段接上
        if (hello.reply && json(m.payload).reply_id === hello.reply) helloDone();
        else if (current?.via && current.replyId && json(m.payload).reply_id === current.replyId) {
          current.ttsDone = true;
          maybeFinished();
        }
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

  const FRAME = 640; // 20ms
  const ENROLL_BYTES = ENROLL_SECONDS * 32000;
  /** 他开口一秒多了：认一认是不是他，是他就打断她 */
  const checkEarly = async (buf: Buffer[]) => {
    checking = true;
    try {
      const score = await voiceprintScore(Buffer.concat(buf));
      if (utter !== buf || score === null) return; // 这句已经说完/换了下一句
      verdict = score >= VOICEPRINT_MAYBE;
      console.log(
        `[dongni][call] 声纹 开头 ${score.toFixed(2)} ${score >= VOICEPRINT_MIN ? "是他" : verdict ? "大概是他" : "不像他"}`,
      );
      if (verdict) {
        interrupt();
        if (userText) tell({ type: "you", text: userText });
      }
    } catch (e) {
      console.warn("[dongni][call] 声纹没认成：", e instanceof Error ? e.message : e);
      verdict = true; // 认不了就别把他拦在外面
    } finally {
      checking = false;
    }
  };

  /**
   * 不用他手动录声纹：还没录过时，把他电话里说的话攒够十来秒，自动录成他的声纹，之后就只认他。
   * 录错了（比如旁边有人在说）点通话里那个按钮重录。
   */
  const auto: Buffer[] = [];
  let autoBusy = false;
  const autoEnroll = async (heard: Buffer[]) => {
    if (autoBusy) return;
    auto.push(Buffer.concat(heard));
    const all = Buffer.concat(auto);
    if (all.length < AUTO_ENROLL_SECONDS * 32000) return;
    autoBusy = true;
    const r = await enrollVoiceprint(all).catch((e) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
    console.log(`[dongni][call] 声纹自动录入 ${r.ok ? "好了" : `没成：${r.message}`}（${(all.length / 32000).toFixed(1)} 秒）`);
    auto.length = 0; // 没录成要重攒；录成了也不用留着（voiceprint() 已经有值了）
    if (r.ok) tell({ type: "enrolled" });
    autoBusy = false;
  };

  // 页面传来的是 16k 单声道 16 位 PCM，原样转给豆包；文字消息是控制（录声纹）
  page.on("message", async (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const m = json(Buffer.from(data));
      if (m.type === "enroll") {
        enrolling = [];
        utter = null;
        verdict = null;
      }
      return;
    }
    if (!ready || up.readyState !== WebSocket.OPEN) return;
    const pcm = Buffer.from(data);
    if (enrolling) {
      enrolling.push(pcm);
      const got = enrolling.length * FRAME;
      if (enrolling.length % 25 === 0) tell({ type: "enroll", progress: Math.min(1, got / ENROLL_BYTES) });
      if (got >= ENROLL_BYTES) {
        const all = Buffer.concat(enrolling);
        enrolling = null;
        const r = await enrollVoiceprint(all).catch((e) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
        console.log(`[dongni][call] 声纹录入 ${r.ok ? "好了" : `没成：${r.message}`}`);
        tell(r.ok ? { type: "enrolled" } : { type: "enroll-failed", message: r.message });
      }
      // 录的时候她别听见（送静音保持连线）
      up.send(frame(200, null, sid, 0b0010, Buffer.alloc(pcm.length)));
      return;
    }
    pre.push(pcm);
    if (pre.length > 25) pre.shift();
    if (utter) {
      utter.push(pcm);
      if (verdict === null && !checking && utter.length >= 60 && voiceprint()) void checkEarly(utter);
    }
    up.send(frame(200, null, sid, 0b0010, pcm));
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
