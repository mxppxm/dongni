import "server-only";
import { db } from "./db";
import { repeatedAlready, selfNarration, silence, type Silence } from "./dedupe";

/**
 * 开口之前的统一闸门：主动消息、「我改好了/重启了/你试试」这类自述，都先过这里再发。
 * 三件事一起看——这话刚才是不是说过、他是不是连着几条没回、现在是不是凌晨他正睡着。
 * 过不了就直接不发（不是攒着下次再发）。
 *
 * 自我修复那条路（lib/selfrepair.ts）是内核、改不了，它自己把话写进对话。
 * 所以那边由 lib/speak.ts 先判定，再把这一句登记到 silent_says；写库时由触发器吞掉，
 * 保证「拦」这件事只有一套规矩，不会一部分拦下、一部分漏出去。
 */

/** 他连着没回时，她最多追着说几条（不算本该回他的那一句）；到这儿就静默到他先开口 */
const MAX_EXTRA = 3;
/** 已经在追着说了：「我自己这边好了」这类进度话就别再追着说 */
const EXTRA_QUIET = 1;
/** 凌晨他在睡：进度话一律不说，等他醒了自然会说上 */
const SLEEP_FROM_MIN = 30; // 00:30
const SLEEP_TO_MIN = 7 * 60; // 07:00
/** 登记过要拦的句子只在这个窗口内有效，过时自动失效，不会误伤之后的话 */
const SUPPRESS_TTL = 60_000;

export type SayVerdict = { ok: true } | { ok: false; why: string };

/** 表 + 触发器：登记过的句子在写库那一刻被静默丢掉（INSERT 不报错、不落库） */
function ensureGate() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS silent_says (
      text TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS silent_says_guard
    BEFORE INSERT ON messages
    WHEN NEW.role = 'assistant' AND EXISTS (
      SELECT 1 FROM silent_says WHERE text = NEW.content AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000
    )
    BEGIN
      DELETE FROM silent_says WHERE text = NEW.content;
      SELECT RAISE(IGNORE);
    END;
  `);
}

/** 现在是不是凌晨、他多半睡着的时间 */
export function inSleepHours(now = Date.now()) {
  const d = new Date(now);
  const min = d.getHours() * 60 + d.getMinutes();
  return min >= SLEEP_FROM_MIN && min < SLEEP_TO_MIN;
}

/**
 * 这句准备发出去的话，现在该不该说。主动消息和自我修复的自述都走这里，规矩只有一份。
 * 正常接他的话不算在内——他开口了就该有人应声。
 */
export function verdict(text: string, s: Silence = silence(), now = Date.now()): SayVerdict {
  const body = text.trim();
  if (!body) return { ok: false, why: "没有话可说" };
  try {
    ensureGate();
  } catch (e) {
    console.error("[dongni] 发送闸门没建起来：", e instanceof Error ? e.message : e);
  }
  const repeat = repeatedAlready(body, s);
  // 硬上限：他连着没回时追着说的条数有上限，到这儿就静默到他先开口——有新由头也不说
  if (s.extra >= MAX_EXTRA) return { ok: false, why: `他连着 ${s.extra} 条没回，到他先开口为止都不说了` };
  if (repeat.repeated) return { ok: false, why: repeat.why ?? "刚才说过同一件事" };
  // 自述（改好了、重启了、你试试、还没弄完）：他没问就别追着说
  if (selfNarration(body)) {
    if (s.extra >= EXTRA_QUIET) return { ok: false, why: `他连着 ${s.extra} 条没回` };
    if (inSleepHours(now)) return { ok: false, why: "凌晨他在睡" };
  }
  return { ok: true };
}

/** 这一句不让说了：登记到库里，让写库那一步把它吞掉（失败也不吵，最多是照原样发出去） */
export function suppress(text: string) {
  const body = text.trim();
  if (!body) return;
  try {
    ensureGate();
    const now = Date.now();
    const d = db();
    d.prepare("DELETE FROM silent_says WHERE expires_at <= ?").run(now);
    d.prepare("INSERT INTO silent_says(text, expires_at) VALUES(?, ?) ON CONFLICT(text) DO UPDATE SET expires_at = excluded.expires_at").run(
      body,
      now + SUPPRESS_TTL,
    );
  } catch (e) {
    console.error("[dongni] 这句话没拦住：", e instanceof Error ? e.message : e);
  }
}