import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import { speakReminder } from "./reminder-voice";

/**
 * 定时提醒：存在 data/reminders.json，进程里用一个 Map 管所有定时器（设一个清一个，取消就清掉）。
 * 到点让敏用自己的口吻在对话里说一句（前端轮询会看到）+ 发一条 macOS 通知。
 * 重启后从文件读回来：还没到点的重新上表；已经过点的立刻补发一次，不会丢。
 */
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "reminders.json");
const KEEP_FIRED_MS = 3 * 86400_000;
// setTimeout 最大约 24.8 天，超了就分段上表
const MAX_TIMEOUT = 2_000_000_000;

export type Reminder = { id: number; text: string; at: number; createdAt: number; firedAt: number | null };

type State = { loaded: boolean; timers: Map<number, NodeJS.Timeout>; list: Reminder[] };

const state = ((globalThis as unknown as { __dongniReminders?: State }).__dongniReminders ??= {
  loaded: false,
  timers: new Map<number, NodeJS.Timeout>(),
  list: [] as Reminder[],
});

function load() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { reminders?: unknown })?.reminders;
    if (!Array.isArray(list)) return;
    state.list = list.flatMap((x) => {
      const o = (x ?? {}) as Partial<Reminder>;
      const id = Number(o.id);
      const at = Number(o.at);
      const text = typeof o.text === "string" ? o.text : "";
      if (!Number.isFinite(id) || !Number.isFinite(at) || !text.trim()) return [];
      return [{ id, text, at, createdAt: Number(o.createdAt) || at, firedAt: o.firedAt ? Number(o.firedAt) : null }];
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[dongni] 读提醒文件失败，按没有处理：", e);
  }
  // 谁先用到提醒（启动钩子或接口）就把没到点的都上表，重启后不会漏
  for (const r of state.list) if (!r.firedAt) arm(r);
}

function save() {
  const now = Date.now();
  state.list = state.list.filter((r) => !r.firedAt || now - r.firedAt < KEEP_FIRED_MS);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ reminders: state.list }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error("[dongni] 提醒存盘失败：", e);
  }
}

function clearTimer(id: number) {
  const t = state.timers.get(id);
  if (t) clearTimeout(t);
  state.timers.delete(id);
}

function arm(r: Reminder) {
  clearTimer(r.id);
  if (r.firedAt) return;
  const delay = r.at - Date.now();
  if (delay > MAX_TIMEOUT) {
    state.timers.set(
      r.id,
      setTimeout(() => arm(r), MAX_TIMEOUT),
    );
    return;
  }
  state.timers.set(
    r.id,
    setTimeout(() => void fire(r.id), Math.max(0, delay)),
  );
}

function notify(text: string) {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
  execFile(
    "/usr/bin/osascript",
    ["-e", `display notification "${esc(text)}" with title "懂你" sound name "Ping"`],
    { timeout: 10_000 },
    (e) => {
      if (e) console.warn("[dongni] 系统通知没发出去：", e.message);
    },
  );
}

async function fire(id: number) {
  load();
  clearTimer(id);
  const r = state.list.find((x) => x.id === id);
  if (!r || r.firedAt) return;
  // 先在内存里标成已触发，不会重复响；存盘等话写好之后——中途重启就重来一次，不丢
  r.firedAt = Date.now();
  // 系统通知用当初设的原始内容，立刻发，不等模型
  notify(r.text);
  // 对话里让她自己说一句（模型抽风就用原话，不加前缀）
  const said = await speakReminder(r.text);
  // extracted=1：提醒不是对方说的话，不用拿来整理记忆
  db()
    .prepare("INSERT INTO messages(role, content, status, extracted, created_at) VALUES('assistant', ?, 'done', 1, ?)")
    .run(said, Date.now());
  save();
  console.log(`[dongni] 提醒 #${r.id} 到点：${r.text} → 说：${said}`);
}

/** 服务启动时把提醒重新上表；关机期间错过的立刻补上 */
export function startReminders() {
  load();
  const pending = state.list.filter((r) => !r.firedAt).length;
  if (pending) console.log(`[dongni] 有 ${pending} 个待触发的提醒`);
}

export function pendingReminders(): Reminder[] {
  load();
  return state.list.filter((r) => !r.firedAt).sort((a, b) => a.at - b.at);
}

/** 最近触发的（前端拿去弹提醒，弹过的自己记着不重复弹） */
export function firedReminders(sinceMs = 10 * 60_000): Reminder[] {
  load();
  const now = Date.now();
  return state.list
    .filter((r) => r.firedAt && now - r.firedAt < sinceMs)
    .sort((a, b) => (a.firedAt ?? 0) - (b.firedAt ?? 0));
}

export function addReminder(text: string, at: number): Reminder {
  load();
  const now = Date.now();
  const r: Reminder = {
    id: state.list.reduce((m, x) => Math.max(m, x.id), 0) + 1,
    text: text.trim(),
    at,
    createdAt: now,
    firedAt: null,
  };
  state.list.push(r);
  save();
  arm(r);
  return r;
}

export function cancelReminder(id: number): Reminder | null {
  load();
  const i = state.list.findIndex((r) => r.id === id && !r.firedAt);
  if (i < 0) return null;
  const [r] = state.list.splice(i, 1);
  clearTimer(id);
  save();
  return r;
}

/**
 * 把「绝对时间」解析成本地时间戳，认这几种写法：
 * 1700000000000（毫秒）/ 1700000000（秒）/ 2025-11-01 21:30 / 2025-11-01T21:30:00 / 带时区的 ISO / 21:30（今天，过了就算明天）
 */
export function resolveWhen(at: string, now = Date.now()): number | null {
  const s = at.trim();
  if (!s) return null;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  // 带时区的 ISO 交给 Date 自己算
  if (/^\d{4}-\d{1,2}-\d{1,2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const full = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (full) {
    const t = new Date(+full[1], +full[2] - 1, +full[3], +(full[4] ?? 0), +(full[5] ?? 0), +(full[6] ?? 0)).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(now);
    d.setHours(+hm[1], +hm[2], 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}