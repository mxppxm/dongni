import "server-only";
import fs from "node:fs";
import path from "node:path";
import { myName, notify } from "./notify";
import { db, getKv, setKv, type MessageRow } from "./db";
import { repeatContext, silence, type Silence } from "./dedupe";
import { verdict } from "./send";
import { completeJson } from "./llm";
import { activeMemories, formatMemories, getProfile, nowText } from "./memory";
import { INTRO, PERSONA, SPEAKING } from "./persona";
import { pendingReminders } from "./reminders";
import { postAssistant, startRepair } from "./selfrepair";
import { runTool } from "./tools";

/**
 * 主动找对方：每隔一会儿想一想「现在有没有值得说的」，有就发一条，并弹系统通知。
 * 也会回看自己的毛病，有确凿问题时自己动手改（一天最多一次）。
 *
 * 他还没回话时不许一直追着说：连发到 3 条就到头（见 quietGate / MAX_EXTRA）。
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
 * 所以在这里用记录卡两道：
 * 1）他一条都没回（除了本该回他的那句）时默认闭嘴，只有真新由头（他提过的事到点、新报错）才开口；
 * 2）连着追到 3 条就到头，静默到他先开口，再有新由头也不说。
 */
const MAX_EXTRA = 3;
/** 他说过的事在这一小时内到点，算新由头 */
const DUE_WINDOW_MS = 60 * 60_000;
/** 日志里这些是自己会重试、会兜底的小毛病，不算「新报错」，不值得为它去打扰他 */
const ERR_ROUTINE = /第 \d+ 次(回复失败|没接上话)|几次都没接上话|写库失败/;

/** 这轮还非说不可的理由：日志里真有新报错，或者他说过的事到点了。没有就是 null */
function freshReason(errors: string): string | null {
  if (errors.split("\n").some((l) => l.trim() && !ERR_ROUTINE.test(l))) return "运行日志里出现了新的报错";
  const now = Date.now();
  const due = pendingReminders().find((r) => r.at - now <= DUE_WINDOW_MS);
  return due ? `他说过的事到点了：${due.text}` : null;
}

export type QuietGate = { block: boolean; capped: boolean; reason: string | null };

/** 他还没回话、这轮该不该开口 */
export function quietGate(s: Silence, errors: string): QuietGate {
  const reason = freshReason(errors);
  if (s.extra >= MAX_EXTRA) return { block: true, capped: true, reason };
  if (s.extra >= 1 && !reason) return { block: true, capped: false, reason: null };
  return { block: false, capped: false, reason };
}

export async function proactiveTick() {
  if (state.running) return;
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
    const canImprove = true; // 对方说不给她设限：每次都可以回看自己
    // 去重用的上下文：他上一条之后她说过什么、他沉默多久了
    const quiet = silence();
    const said = repeatContext(quiet);
    // 日志只看一次：既当「新由头」用，也贴进提示词；先看掉后面就捞不着了
    const errors = recentErrors();
    const gate = quietGate(quiet, errors);

    const r = await completeJson<Decision>([
      {
        role: "system",
        content: `${INTRO}

${PERSONA}

${SPEAKING}

你的名字是「${myName()}」。现在没人跟你说话，你在想：此刻要不要主动给对方发一条消息。现在是 ${nowText()}。

值得主动说的（要有具体由头）：
- 之前提过的事到点了或刚过去：面试、考试、出行、体检、截止日、约会……问问结果/状态
- 从对方今天在电脑上改的文件，看出在忙什么，可以关心一句或给个具体的帮忙
- 对方之前情绪不好、身体不舒服，过了一阵问问现在怎么样
- 你想到一个和对方兴趣、在做的事真正相关的点子或信息
- 上次聊到一半没说完的话题

不该发的：没有具体由头的「在吗」「最近怎么样」；重复你最近已经说过的；说教；太长。
要发的话，就按上面那套说话方式来写：一两句、口语、具体、接得上你们上次聊的话头，不要客套开场白。没有值得说的就 send=false，宁缺毋滥。

${gate.capped
  ? `【这轮别开口】${said.silent}连发已经到上限了：除非他先开口，否则一个字都别发。这轮只能是 send=false，message 留空。\n`
  : gate.block
    ? `【这轮别开口】${said.silent}他还没回话，多半在忙或者已经不在电脑前了。这轮只能是 send=false，message 留空；除非有真正的新由头（他提过的事到点了、你刚发现的新报错），否则一个字都别发。\n`
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

    if (r.send && r.message?.trim()) {
      const text = r.message.trim();
      if (gate.block) {
        // 模型不听话：他还没回话、连发到上限，或者没有新由头——一律硬拦
        console.log(`[dongni] 主动消息没发：${gate.capped ? "连发到上限了，等他先开口" : "他还没回话，也没有新由头"}——${text}`);
      } else {
        // 发之前统一过一道闸：这句话最近说过、或者他沉默/睡着了还在自述，就不发（模型常常不听提示词，硬拦一道）
        const v = verdict(text, quiet);
        if (!v.ok) {
          console.log(`[dongni] 主动消息没发：${v.why}——${text}`);
        } else {
          postAssistant(text);
          const id = (d.prepare("SELECT MAX(id) m FROM messages").get() as { m: number }).m;
          setKv("proactive_last_id", String(id));
          setKv("proactive_last_at", String(now));
          setKv("proactive_day", today);
          setKv("proactive_count", String(todayCount + 1));
          notify(text);
          console.log(`[dongni] 主动发消息：${text}`);
        }
      }
    }
    if (canImprove && r.improve?.trim()) {
      setKv("improve_last_at", String(now));
      console.log(`[dongni] 自己决定改进：${r.improve.trim()}`);
      startRepair(`（这是你自己回看后决定的改进）${r.improve.trim()}`);
    }
  } catch (e) {
    console.error("[dongni] 主动思考失败：", e instanceof Error ? e.message : e);
  } finally {
    state.running = false;
  }
}
