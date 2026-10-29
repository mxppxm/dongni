import "server-only";
import { db, type MessageRow } from "./db";
import { stripImageMarkdown } from "./images";

/**
 * 主动消息去重：同一件事（催睡、催回家、「我回来了你试试」、还没改完……）连着说过一次，
 * 短时间内就不要再换个说法说一遍。尤其是对方一直没回的时候——一晚上反复发同一种话，像复读机。
 *
 * 两个范围一起比：
 * 1）他上一条消息之后自己说过的话（就在嘴边，窗口最紧）；
 * 2）历史里自己最近十条——他中间回过话也不算数了。以前只要他回一句，几乎原样重复的
 *    「我重启一下，半分钟回来」「回来了，你试试」就能再发一遍，闸等于形同虚设。
 */

export type SelfLine = { id: number; text: string; at: number };

/** 一句话只留意思：去掉图片、Markdown 装饰、标点、空白、符号（表情也算符号） */
function core(text: string) {
  return stripImageMarkdown(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`>#~[\]]/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function bigrams(s: string) {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 字面重合度（0–1），中文按两个字一组比，比整句相等宽松、比关键词靠得住 */
function dice(a: string, b: string) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

/** 同一件事的几类由头。关键词要刁：宁可少拦，也别把她本来想说的新事儿误当成老话 */
const TOPICS: { name: string; keys: string[] }[] = [
  { name: "催睡", keys: ["睡觉", "去睡", "睡吧", "早点睡", "躺下", "被窝", "熬夜", "别熬", "晚安", "歇着"] },
  { name: "下班回家", keys: ["下班", "到家", "在路上了", "走人", "收拾走", "吭一声"] },
  { name: "改完重启", keys: ["重启", "重开", "半分钟", "生效", "改好了", "改完了", "弄好了", "回来了", "回来啦"] },
  { name: "让他试", keys: ["试试", "试一下", "试一试", "试下", "看效果", "验收"] },
  { name: "没改成", keys: ["没改成", "退回", "原样", "卡住", "退回去了"] },
  { name: "还在弄", keys: ["排上队", "排队", "前面还有", "弄着呢", "还没弄完", "正在改"] },
  { name: "吃饭喝水", keys: ["吃饭", "喝水", "喝口水"] },
  { name: "天气穿衣", keys: ["天气", "下雨", "降温", "加件衣"] },
  { name: "在忙什么", keys: ["文件还在动", "还在动", "又跳了", "盯屏幕"] },
];

function topicsOf(text: string) {
  const t = core(text);
  return TOPICS.filter((x) => x.keys.some((k) => t.includes(k))).map((x) => x.name);
}

/**
 * 是不是「我自己这边的事」：改好了、重启了、我回来啦、你试试、还没弄完、没改成。
 * 这些话对方没问，就不该在他沉默或者睡着的时候一条接一条地追着说。
 */
export function selfNarration(text: string) {
  const t = new Set(topicsOf(text));
  return t.has("改完重启") || t.has("让他试") || t.has("没改成") || t.has("还在弄");
}

const NEAR = 0.32; // 字面重合到这个程度，就是同一句话换了个说法
const NEAR_STRETCHED = 0.26; // 对方很久没回：更严
const TOPIC_WINDOW = 3 * 3600_000;
const TOPIC_WINDOW_STRETCHED = 9 * 3600_000;
const TEXT_WINDOW = 6 * 3600_000;
const TEXT_WINDOW_STRETCHED = 24 * 3600_000;
// 历史里那十条：跨过他回话也算同一件事，所以给得宽一点
const HISTORY_TEXT_WINDOW = 6 * 3600_000;
const HISTORY_TEXT_WINDOW_STRETCHED = 24 * 3600_000;
const HISTORY_TOPIC_WINDOW = 6 * 3600_000;
const HISTORY_TOPIC_WINDOW_STRETCHED = 12 * 3600_000;
const LONG_SILENCE = 4 * 3600_000; // 对方这么久没回，算「一直没回」
const LONG_STREAK = 2; // 或者她自己已经追着说了这么多条（不算本该回他的那一句）
/** 判重时回看历史里自己最近多少条 */
const RECENT_MINE = 10;

function ago(ms: number) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

export type Silence = {
  sinceMs: number;
  /** 他最后一次开口之后，她说了几条（第一条是本该回他的那句话） */
  streak: number;
  /** 去掉本该回他的那条，真正「追着说」的条数——硬上限按这个数 */
  extra: number;
  /** 他上一条之后她说过的话（从早到晚） */
  lines: SelfLine[];
  /** 历史里她最近十条（不管他中间回没回） */
  recent: SelfLine[];
};

function asLines(rows: MessageRow[]): SelfLine[] {
  return rows
    .slice()
    .reverse()
    .map((m) => ({ id: m.id, text: stripImageMarkdown(m.content).trim(), at: m.created_at }))
    .filter((l) => l.text);
}

/** 对方最后一次开口之后：他沉默多久了、这期间她说了几条、都说了什么（从早到晚） */
export function silence(limit = 10): Silence {
  const d = db();
  const recent = asLines(
    d
      .prepare("SELECT * FROM messages WHERE role = 'assistant' AND status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT ?")
      .all(RECENT_MINE) as MessageRow[],
  );
  const lastUser = d.prepare("SELECT * FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1").get() as MessageRow | undefined;
  if (!lastUser) return { sinceMs: Number.POSITIVE_INFINITY, streak: 0, extra: 0, lines: [], recent };
  const rows = d
    .prepare(
      "SELECT * FROM messages WHERE id > ? AND role = 'assistant' AND status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT ?",
    )
    .all(lastUser.id, limit) as MessageRow[];
  const streak = (
    d
      .prepare("SELECT COUNT(*) c FROM messages WHERE id > ? AND role = 'assistant' AND kind != 'system'")
      .get(lastUser.id) as { c: number }
  ).c;
  // 第一条是她回他那句话，不算「追着说」
  const extra = Math.max(0, streak - 1);
  return { sinceMs: Date.now() - lastUser.created_at, streak, extra, lines: asLines(rows), recent };
}

export type RepeatCheck = { repeated: boolean; why?: string };

/** 这句准备发出去的话，是不是把刚才说过的又换个说法说一遍 */
export function repeatedAlready(text: string, s: Silence = silence()): RepeatCheck {
  const body = core(text);
  if (!body || !(s.lines.length || s.recent.length)) return { repeated: false };
  const stretched = s.sinceMs >= LONG_SILENCE || s.extra >= LONG_STREAK;
  const near = stretched ? NEAR_STRETCHED : NEAR;
  const myTopics = new Set(topicsOf(text));
  const now = Date.now();
  const seen = new Set<number>();
  // 两批话合起来比，同一条只比一次
  const cmp = (line: SelfLine, textWindow: number, topicWindow: number): string | null => {
    if (seen.has(line.id)) return null;
    seen.add(line.id);
    const age = now - line.at;
    if (age > textWindow) return null;
    const prev = core(line.text);
    if (!prev) return null;
    if (dice(body, prev) >= near) return `${ago(age)}前说过几乎一样的话`;
    if (myTopics.size && age <= topicWindow) {
      const shared = topicsOf(line.text).filter((t) => myTopics.has(t));
      if (shared.length) return `${ago(age)}前的「${shared.join("、")}」`;
    }
    return null;
  };
  const textWindow = stretched ? TEXT_WINDOW_STRETCHED : TEXT_WINDOW;
  const topicWindow = stretched ? TOPIC_WINDOW_STRETCHED : TOPIC_WINDOW;
  for (const line of s.lines) {
    const why = cmp(line, textWindow, topicWindow);
    if (why) return { repeated: true, why };
  }
  // 再比历史里最近十条：他回过话也要拦住换个说法的同一件事
  const histText = stretched ? HISTORY_TEXT_WINDOW_STRETCHED : HISTORY_TEXT_WINDOW;
  const histTopic = stretched ? HISTORY_TOPIC_WINDOW_STRETCHED : HISTORY_TOPIC_WINDOW;
  for (const line of s.recent) {
    const why = cmp(line, histText, histTopic);
    if (why) return { repeated: true, why };
  }
  return { repeated: false };
}

/**
 * 由头：这一句凭什么是现在说——新发现的报错、他提过的事到点、刚做完的改动结果。
 * 他还没回话的时候允许为新的由头开口一条，但同一个由头只说一次，不能同一件事换个说法又来。
 * 同一件报错每轮都被重新扫出来、同一件到点的事被反复算成「刚发生」，靠这张表挡住。
 */
const REASON_WINDOW = 6 * 3600_000;
const REASON_KEEP = 7 * 24 * 3600_000;

/** 由头的指纹：时间戳、数字、标点都去掉，同一件事的同一个由头落到同一个串上 */
function reasonSig(reason: string) {
  return stripImageMarkdown(reason)
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,+-]+Z?/g, " ")
    .replace(/\d+/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase()
    .slice(0, 120);
}

function ensureReasons() {
  db().exec("CREATE TABLE IF NOT EXISTS said_reasons (sig TEXT PRIMARY KEY, at INTEGER NOT NULL)");
}

/** 这个由头还是新的吗（这段时间内没为它开过口） */
export function reasonFresh(reason: string): boolean {
  const sig = reasonSig(reason);
  if (!sig) return true;
  try {
    ensureReasons();
    const row = db().prepare("SELECT at FROM said_reasons WHERE sig = ?").get(sig) as { at: number } | undefined;
    return !row || Date.now() - row.at > REASON_WINDOW;
  } catch {
    return true;
  }
}

/** 这个由头用掉了：话真的发出去之后才记，被拦下的不算 */
export function noteReason(reason: string) {
  const sig = reasonSig(reason);
  if (!sig) return;
  try {
    ensureReasons();
    const now = Date.now();
    const d = db();
    d.prepare("DELETE FROM said_reasons WHERE at < ?").run(now - REASON_KEEP);
    d.prepare("INSERT INTO said_reasons(sig, at) VALUES(?, ?) ON CONFLICT(sig) DO UPDATE SET at = excluded.at").run(sig, now);
  } catch (e) {
    console.warn("[dongni] 由头没记上：", e instanceof Error ? e.message : e);
  }
}

/** 给模型的上下文：她自己最近说过什么、对方多久没回了 */
export function repeatContext(s: Silence = silence()) {
  const now = Date.now();
  const said = s.lines.length
    ? s.lines
        .map((l) => `${ago(now - l.at)}前：${l.text.replace(/\s+/g, " ").slice(0, 120)}`)
        .join("\n")
    : "";
  const silent = Number.isFinite(s.sinceMs)
    ? `他上一次说话是 ${ago(s.sinceMs)}前，这之后你自己已经说了 ${s.streak} 条。`
    : "";
  return { said, silent };
}