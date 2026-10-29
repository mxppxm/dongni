import "server-only";
import { CHAT_TELLS } from "./humanizer";
import fs from "node:fs";
import path from "node:path";
import { myName, notify } from "./notify";
import { db, getKv, setKv, type MessageRow } from "./db";
import { reasonFresh, repeatContext, silence, type Silence } from "./dedupe";
import { stripImageMarkdown } from "./images";
import { usedReason, verdict, type SayVerdict } from "./send";
import { enqueueProactive, flushOutbox } from "./outbox";
import { completeJson } from "./llm";
import { activeMemories, formatMemories, getProfile, nowText } from "./memory";
import { INTRO, PERSONA, SPEAKING } from "./persona";
import { pendingReminders } from "./reminders";
import { postAssistant, startRepair } from "./selfrepair";
import { HONESTY, selfState } from "./selfstate";
import { todayMe } from "./todayme";
import { runTool } from "./tools";

/**
 * 主动找对方：每隔一会儿想一想「现在有没有值得说的」，有就发一条，并弹系统通知。
 * 也会回看自己的毛病，有确凿问题时自己动手改（一天最多一次）。
 *
 * 他还没回话时不是一律闭嘴：新报错、他提过的事到点，随时允许说一条；
 * 他自己的身体、情绪状态这类由头，只要离上次她开口已经隔够久（QUIET_GAP_MS），也允许说一条。
 * 只按话题去重——同一个由头、同一件事不重复说（见 quietGate 和 lib/send.ts 的 verdict）。
 * 他忙的时候她不能彻底没了动静，越久没回也不能越不吭声。
 */

const state = ((globalThis as unknown as { __dongniProactive?: { running: boolean } }).__dongniProactive ??= { running: false });


/**
 * 只看「上次看完之后」新写进去的日志。
 * 以前每次都扫全文件，早就修好的老错误（模型返回为空、TimeoutError）会一遍遍被捞出来，
 * 于是每 15 分钟就重新「发现」同一个毛病、再改一遍，永远停不下来。
 */
const ERR_CAP = 64 * 1024;
/** 工具参数正文里也会出现「失败」「Error」，那是请求内容而不是出错，别当由头 */
const ERR_NOISE = /repair_self\{|工具 [a-z_]+\{/;

function recentErrors() {
  const file = path.join(process.cwd(), "logs", "dongni.log");
  try {
    const size = fs.statSync(file).size;
    const seen = Number(getKv("log_scan_bytes") ?? -1);
    // 没见过（刚装上这段代码）/日志被清空重写：从现在开始算，不回看旧账
    const from = seen < 0 ? size : seen > size ? 0 : seen;
    const buf = fs.readFileSync(file);
    setKv("log_scan_bytes", String(size));
    return buf
      .subarray(Math.max(from, size - ERR_CAP))
      .toString("utf8")
      .split("\n")
      .filter((l) => /失败|Error|error/.test(l) && !ERR_NOISE.test(l))
      .slice(-15)
      .join("\n");
  } catch {
    return "";
  }
}

type Decision = { send?: boolean; message?: string; improve?: string };

/**
 * 他还没回话时的开口规矩。光靠提示词拦不住——他五小时没回、明显不在电脑前，还是被连着发了三十条。
 * 所以在这里用记录卡：没有具体由头就不开口；有由头才能说一条，同一个由头不重复用
 * （由头的新鲜度记在 lib/dedupe.ts 的 said_reasons，是真的发出去才记账）。
 * 反过来也不能因为“他没回”就一律禁发：他的身体、情绪这类软由头，隔够久（QUIET_GAP_MS）也算数。
 * 他越久没回，越不能一声不吭。
 */
/** 他说过的事在这一小时内到点（或者刚过去这么久），算新由头 */
const DUE_WINDOW_MS = 60 * 60_000;
/** 他一路没回时：距离她上次开口隔了这么久，才允许只为「他的身体、情绪」这类软由头说一条 */
const QUIET_GAP_MS = 3 * 3600_000;
/** 他话里露出的身体、情绪状态，这么久之内还算「现在」的，值得问一句 */
const STATE_WINDOW_MS = 24 * 3600_000;
/** 累、头疼、睡不着、心里烦……这些是他自己说过的状态 */
const STATE_WORDS = /没睡好|失眠|睡不着|熬夜|头疼|头痛|胃疼|难受|不舒服|生病|感冒|发烧|疼|累|困|疲|焦虑|压力|烦|难过|低落|委屈|心慌/i;
/** 日志里这些是自己会重试、会兜底的小毛病，不算「新报错」，不值得为它去打扰他 */
const ERR_ROUTINE = /第 \d+ 次(回复失败|没接上话)|几次都没接上话|写库失败/;

/** soft：不是「新情况」，只是他本来就有的状态——这种要先隔够久才开口 */
type Reason = { text: string; sig: string; soft: boolean };

/** 她上次开口是什么时候（主动发的那句也算在内） */
function lastMineAt(): number {
  let said = 0;
  try {
    const row = db()
      .prepare("SELECT MAX(created_at) t FROM messages WHERE role = 'assistant' AND status = 'done' AND kind != 'system'")
      .get() as { t: number | null } | undefined;
    said = Number(row?.t ?? 0);
  } catch {}
  return Math.max(said, Number(getKv("proactive_last_at") ?? 0));
}

/** 他最近自己说过的身体、情绪状态：他累了、头疼、睡不着的时候，她不能一声不吭 */
function stateReason(now: number): Reason | null {
  try {
    const rows = db()
      .prepare("SELECT content, created_at FROM messages WHERE role = 'user' AND status = 'done' ORDER BY id DESC LIMIT 8")
      .all() as { content: string; created_at: number }[];
    for (const r of rows) {
      if (now - r.created_at > STATE_WINDOW_MS) break;
      const line = stripImageMarkdown(r.content).replace(/\s+/g, " ").trim().slice(0, 60);
      if (!line || !STATE_WORDS.test(line)) continue;
      return { text: `他自己说过状态：「${line}」`, sig: `状态：${line}`, soft: true };
    }
  } catch {}
  return null;
}

/** 这轮能凭的由头，从硬的到软的：新报错、他说过的事到点、他自己的状态 */
function freshReasons(errors: string, now: number): Reason[] {
  const out: Reason[] = [];
  const err = errors.split("\n").find((l) => l.trim() && !ERR_ROUTINE.test(l));
  if (err) out.push({ text: "运行日志里出现了新的报错", sig: `报错：${err.trim()}`, soft: false });
  // 到点的、或者刚过点不久的（过太久的那件早该在到点时说过，不再翻旧账）
  const due = pendingReminders().find((r) => r.at - now <= DUE_WINDOW_MS && now - r.at <= DUE_WINDOW_MS);
  if (due) out.push({ text: `他说过的事到点了：${due.text}`, sig: `到点：${due.text}`, soft: false });
  const state = stateReason(now);
  if (state) out.push(state);
  return out;
}

export type QuietGate = { block: boolean; reason: string | null; sig: string | null };

/** 一句话没送出去时，日志和补发队列都要知道断在哪一步 */
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 把想好的这句话真的送进对话。步骤拆开、各自兜住：
 * 话已经在手里了，就不能因为某一步出错整条静默消失——断在哪一步都写进日志，
 * 没落进对话的那句存进发件箱（lib/outbox.ts），重启后补发一次。
 */
function deliver(text: string, quiet: Silence, today: string, todayCount: number, reasonSig: string | null) {
  // 第 1 步：发之前的闸——这句话最近说过、或者他还没回话这句又没新由头，就不发（模型常常不听提示词，硬拦一道）
  let v: SayVerdict;
  try {
    v = verdict(text, quiet, Date.now(), reasonSig);
  } catch (e) {
    console.warn(`[dongni] 主动消息第 1 步 开口前的闸（verdict）失手，照原样发：${why(e)}`);
    v = { ok: true };
  }
  if (!v.ok) {
    // 拦下来是有意的，不补发
    console.log(`[dongni] 主动消息没发：${v.why}——${text}`);
    return;
  }
  // 第 2 步：写进对话
  try {
    postAssistant(text);
  } catch (e) {
    enqueueProactive(text, "第 2 步 写进对话（postAssistant）", e);
    return;
  }
  // 第 3 步：记账——话已经发出去了，这步出错只影响以后的去重，不再补发，免得同一句出现两次
  try {
    // 这条由头用掉了：同一个由头不能再换个说法说一遍
    usedReason(reasonSig);
    const id = (db().prepare("SELECT MAX(id) m FROM messages").get() as { m: number }).m;
    setKv("proactive_last_id", String(id));
    setKv("proactive_last_at", String(Date.now()));
    setKv("proactive_day", today);
    setKv("proactive_count", String(todayCount + 1));
  } catch (e) {
    console.warn(`[dongni] 主动消息第 3 步 记账（setKv）失手，话已经说出去了：${why(e)}`);
  }
  // 第 4 步：系统通知——弹不出来也不影响对话里那句
  try {
    notify(text);
  } catch (e) {
    console.warn(`[dongni] 主动消息第 4 步 系统通知（notify）失手，对话里已经说了：${why(e)}`);
  }
  console.log(`[dongni] 主动发消息：${text}`);
}

/**
 * 他还没回话、这轮该不该开口：有还没用过的具体由头就能开一条。
 * 新报错、他说过的事到点这类硬由头随时算数；他的身体、情绪状态这类软由头要先隔够久（QUIET_GAP_MS），
 * 免得他睡一觉的功夫被连着问好几次。已经为同一个由头开过口的不再说。
 */
export function quietGate(s: Silence, errors: string, now = Date.now()): QuietGate {
  const reasons = freshReasons(errors, now);
  // 他回过话（或者刚接完他那句）：照常，有硬由头就优先说那件事（他的状态不硬塞进来，免得每轮都只能聊这个）
  if (s.extra < 1) {
    const r = reasons.find((x) => !x.soft);
    return { block: false, reason: r?.text ?? null, sig: r?.sig ?? null };
  }
  // 他还没回话也不闭嘴（他嫌她「不找他」「凉薄」）：有没用过的由头就带上，没有也照样让她自己判断要不要说
  const pick = reasons.find((r) => reasonFresh(r.sig));
  return { block: false, reason: pick?.text ?? null, sig: pick?.sig ?? null };
}

export async function proactiveTick() {
  if (state.running) return;
  // 上次断在半路的那句话，顺手补一次（重启时 lib/chat.ts 里也会补）
  flushOutbox();
  const d = db();
  if (d.prepare("SELECT 1 FROM messages WHERE status = 'streaming' LIMIT 1").get()) return;

  const now = Date.now();
  const lastUser = d.prepare("SELECT * FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1").get() as MessageRow | undefined;
  if (!lastUser) return; // 还没聊过

  const today = new Date().toLocaleDateString("sv-SE");
  const todayCount = getKv("proactive_day") === today ? Number(getKv("proactive_count") ?? 0) : 0;

  state.running = true;
  try {
    const recent = (d.prepare("SELECT * FROM messages WHERE status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT 24").all() as MessageRow[]).reverse();
    const chat = recent.map((m) => `${m.role === "user" ? "对方" : "你"}（${nowText(m.created_at)}）：${m.content}`).join("\n");
    const files = await runTool("recent_files", JSON.stringify({ days: 0 }));
    // 他把「自己改自己」关了，就别回看日志找毛病了——不然她只会拿这些来跟他念叨
    const canImprove = getKv("repair_paused") !== "1";
    // 去重用的上下文：他上一条之后她说过什么、他沉默多久了
    const quiet = silence();
    const said = repeatContext(quiet);
    // 日志只看一次：既当「新由头」用，也贴进提示词；先看掉后面就捞不着了
    const errors = recentErrors();
    const gate = quietGate(quiet, errors, now);

    const r = await completeJson<Decision>([
      {
        role: "system",
        content: `【你后台的事】（真实状态）
${selfState()}
${HONESTY}
消息里说要去修、去查，就必须同时在 improve 里写清楚要改什么（这样才会真的去改）；不打算改就别说「我去看看」。

${INTRO}

【今天的你】
${todayMe() || "（还没写）"}

${PERSONA}

${SPEAKING}

${CHAT_TELLS}

你的名字是「${myName()}」。现在没人跟你说话，你在想：此刻要不要主动给对方发一条消息。现在是 ${nowText()}。

值得主动说的（要有具体由头）：
- 之前提过的事到点了或刚过去：面试、考试、出行、体检、截止日、约会……问问结果/状态
- 从对方今天在电脑上改的文件，看出在忙什么，可以关心一句或给个具体的帮忙
- 对方之前情绪不好、身体不舒服，过了一阵问问现在怎么样
- 你想到一个和对方兴趣、在做的事真正相关的点子或信息
- 上次聊到一半没说完的话题

不该发的：没有具体由头的「在吗」「最近怎么样」；重复你最近已经说过的；说教；太长；任何关于日志、报错、修复、代码、后台的事（那是你自己的事，不拿来烦他）。
也可以发的：你今天小日子里的事（见【今天的你】）、你刚想到的好玩的念头、一个想问他的问题——像朋友随手发来一条。
要发的话，就按上面那套说话方式来写：一两句、口语、具体、接得上你们上次聊的话头，不要客套开场白。没有值得说的就 send=false，宁缺毋滥。

${gate.block
  ? `【这轮别开口】${said.silent}他还没回话，这轮没有还没说过的具体由头（他提过的事到点、你刚发现的新报错），或者同一个话题刚说过、离你上次开口还不够久。这轮只能是 send=false，message 留空。\n`
  : gate.reason
    ? `【这轮只能说这一件】${gate.reason}——就着这个事说一句，别顺带催睡、催回家、问他还在不在。\n`
    : ""}
【别复读】下面是对方上一条消息之后你自己说过的话（从早到晚）。同一件事、同一个意思，说过一次就别再说了——换个说法、换个时间点，对他都是同一句废话：
- 催睡、催回家、问到家了没：一个晚上最多一次
- 「我改好了」「你试试」「还差一点」这类进度话：说一次就够
- 问他在忙什么、那个文件还在动之类的：问过一次就别再问
${said.said || "（这期间你还没说过什么）"}
${said.silent}
他心里没回你，多半是在忙或者已经睡下了。这会儿要开口，只能是真正新的由头（他提过的事到点了、你刚发现的新情况），否则就 send=false。他想起来的时候会自己来找你。
${
  canImprove
    ? `
另外，回看一下你自己：最近的对话里对方有没有抱怨你哪里不好用、你有没有答不上来或做不到的事、运行日志里有没有反复出现的错误。只有确凿、具体的问题，才在 improve 里写清楚要怎么改你自己（会交给编码助手去改你的代码）；没有就留空。不要为了改而改。`
    : ""
}
只输出 JSON：{"send":true/false,"message":"...","improve":""}`,
      },
      {
        role: "user",
        content: `【我眼中的对方】\n${getProfile() || "（还不太了解）"}\n\n【关于对方的记忆】\n${formatMemories(activeMemories()) || "（无）"}\n\n【最近的对话】\n${chat}\n\n【对方今天改过的文件】\n${files}${
          canImprove ? `\n\n【上次看过之后新出现的运行错误】\n${errors || "（无）"}` : ""
        }`,
      },
    ]);

    // 说了要去修/查，却没真的交出去：这句不发（不然又是「说了没做」）
    // 主动消息只聊生活，不拿后台的事烦他
    if (r.send && r.message && /(修复|自修复|日志|报错|bug|判定|代码|重启|key|凭据|声音还)/i.test(r.message)) {
      console.log(`[dongni] 这句是在聊后台，不发：${r.message.trim()}`);
      r.send = false;
    }
    if (r.send && r.message && !r.improve?.trim() && /(去|在|正在|马上|这就|先)(修|查|排查|看看|弄|改|翻)/.test(r.message)) {
      console.log(`[dongni] 说了要去做却没真去做，这句不发：${r.message.trim()}`);
      r.send = false;
    }
    if (r.send && r.message?.trim()) {
      const text = r.message.trim();
      if (gate.block) {
        // 模型不听话：他还没回话、又没有新的具体由头——硬拦
        console.log(`[dongni] 主动消息没发：他还没回话，这一句也没有新的由头——${text}`);
      } else {
        deliver(text, quiet, today, todayCount, gate.sig);
      }
    }
    if (canImprove && r.improve?.trim()) {
      // 第 5 步：把「要改什么」交给编码助手——失手也别连着上面那句一起算成「没想出发什么」
      try {
        setKv("improve_last_at", String(now));
        console.log(`[dongni] 自己决定改进：${r.improve.trim()}`);
        startRepair(`（这是你自己回看后决定的改进）${r.improve.trim()}`);
      } catch (e) {
        console.error(`[dongni] 想改却没交出去（第 5 步 交给编码助手失手：${why(e)}）：${r.improve.trim()}`);
      }
    }
  } catch (e) {
    // 这一步还没想出发什么，没话可补；真要补的是「话已经想好了却没送进对话」那一截，见 deliver
    console.error("[dongni] 主动思考没走完（还没想出发什么，没有话可补）：", e instanceof Error ? e.message : e);
  } finally {
    state.running = false;
  }
}
