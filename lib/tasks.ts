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
