import "server-only";
import { db, type MessageRow } from "./db";
import { stripImageMarkdown } from "./images";

/**
 * 主动消息去重：同一件事（催睡、催回家、「我回来了你试试」、还没改完……）连着说过一次，
 * 短时间内就不要再换个说法说一遍。尤其是对方一直没回的时候——一晚上反复发同一种话，像复读机。
 *
 * 只拿「对方上一条消息之后」自己说过的话来比：中间他回过话，就说明是新的一段，重复同一个话题是正常的。
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
const LONG_SILENCE = 4 * 3600_000; // 对方这么久没回，算「一直没回」
const LONG_STREAK = 3; // 或者自己已经连说了这么多条

function ago(ms: number) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

export type Silence = { sinceMs: number; streak: number; lines: SelfLine[] };

/** 对方最后一次开口之后：他沉默多久了、这期间她说了几条、都说了什么（从早到晚） */
export function silence(limit = 8): Silence {
  const d = db();
  const lastUser = d.prepare("SELECT * FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1").get() as MessageRow | undefined;
  if (!lastUser) return { sinceMs: Number.POSITIVE_INFINITY, streak: 0, lines: [] };
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
  const lines = rows
    .reverse()
    .map((m) => ({ id: m.id, text: stripImageMarkdown(m.content).trim(), at: m.created_at }))
    .filter((l) => l.text);
  return { sinceMs: Date.now() - lastUser.created_at, streak, lines };
}

export type RepeatCheck = { repeated: boolean; why?: string };

/** 这句准备发出去的话，是不是把刚才说过的又换个说法说一遍 */
export function repeatedAlready(text: string, s: Silence = silence()): RepeatCheck {
  const mine = core(text);
  if (!mine || !s.lines.length) return { repeated: false };
  const stretched = s.sinceMs >= LONG_SILENCE || s.streak >= LONG_STREAK;
  const topicWindow = stretched ? TOPIC_WINDOW_STRETCHED : TOPIC_WINDOW;
  const textWindow = stretched ? TEXT_WINDOW_STRETCHED : TEXT_WINDOW;
  const near = stretched ? NEAR_STRETCHED : NEAR;
  const myTopics = new Set(topicsOf(text));
  const now = Date.now();
  for (const line of s.lines) {
    const age = now - line.at;
    if (age > textWindow) continue;
    const prev = core(line.text);
    if (!prev) continue;
    if (dice(mine, prev) >= near) return { repeated: true, why: `${ago(age)}前说过几乎一样的话` };
    if (myTopics.size && age <= topicWindow) {
      const shared = topicsOf(line.text).filter((t) => myTopics.has(t));
      if (shared.length) return { repeated: true, why: `${ago(age)}前的「${shared.join("、")}」` };
    }
  }
  return { repeated: false };
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