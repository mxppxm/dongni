import "server-only";
import { db } from "./db";

/**
 * 任务登记：她动手干的每件事（画图、拍照、查电脑、写文件、改自己……）都记一笔，页面左边的任务栏照这个画。
 * 只是登记，不管调度——事情照原来的路子跑，这里记下开始、结束、成没成。
 */
export type TaskStatus = "running" | "done" | "error";
export type TaskRow = {
  id: number;
  kind: string;
  title: string;
  status: TaskStatus;
  result: string;
  started_at: number;
  ended_at: number | null;
};

const g = globalThis as unknown as { __dongniTasksReady?: boolean };

function table() {
  if (g.__dongniTasksReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      result TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
  `);
  g.__dongniTasksReady = true;
}

export function startTask(kind: string, title: string): number {
  table();
  return Number(
    db().prepare("INSERT INTO tasks(kind, title, started_at) VALUES(?, ?, ?)").run(kind, title.slice(0, 80), Date.now()).lastInsertRowid,
  );
}

export function finishTask(id: number, ok: boolean, result = "") {
  if (!id) return;
  table();
  db()
    .prepare("UPDATE tasks SET status = ?, result = ?, ended_at = ? WHERE id = ? AND status = 'running'")
    .run(ok ? "done" : "error", result.slice(0, 2000), Date.now(), id);
}

/** 包一层：跑完自动记成败；result 是拿结果算出来的一句（图片 markdown、文件路径之类） */
export async function track<T>(kind: string, title: string, fn: () => Promise<T>, judge?: (r: T) => { ok: boolean; result?: string }) {
  const id = startTask(kind, title);
  try {
    const r = await fn();
    const j = judge?.(r) ?? { ok: true };
    finishTask(id, j.ok, j.result ?? "");
    return r;
  } catch (e) {
    finishTask(id, false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export function listTasks(limit = 40): TaskRow[] {
  table();
  return db().prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT ?").all(limit) as TaskRow[];
}

/** 重启时：上次没跑完的（进程没了）记成中断；改自己那件由重启后的结果来收尾，不在这里动 */
export function markInterrupted() {
  table();
  db()
    .prepare("UPDATE tasks SET status = 'error', result = '中途重启，没跑完', ended_at = ? WHERE status = 'running' AND kind != 'repair'")
    .run(Date.now());
}

/**
 * 给她看的后台真实状态：正在做的、十分钟内做完的。
 * 画图、派活这些丢到后台的事，回复里只留了一句「我去画了」；不把这里给她看，她下一句就以为自己没做，
 * 「说了没做」的核对也看不见，会逼她再做一遍（2026-11-02 一通电话里同一张图画了三遍）。
 */
export function taskStateLines(now = Date.now()): string {
  table();
  const rows = db()
    .prepare("SELECT * FROM tasks WHERE status = 'running' OR ended_at > ? ORDER BY id DESC LIMIT 12")
    .all(now - 10 * 60_000) as TaskRow[];
  const ago = (t: number) => `${Math.max(1, Math.round((now - t) / 60000))} 分钟前`;
  const running = rows.filter((r) => r.status === "running").map((r) => `「${r.title}」（${ago(r.started_at)}开始，还在做）`);
  const done = rows
    .filter((r) => r.status !== "running")
    .map((r) => `「${r.title}」${r.status === "done" ? "做完了" : `没做成（${r.result.slice(0, 40)}）`}（${ago(r.ended_at ?? now)}）`);
  return [
    running.length ? `后台正在做：${running.join("；")}。` : "后台现在没有在做的事。",
    done.length ? `最近做完的：${done.join("；")}。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
