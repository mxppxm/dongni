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
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
  `);
  // 派出去的活要抗重启、能追问：原话、目录、谁在干、对方那边的编号、走到哪一步、完整结果都记在这一行上
  const cols = new Set((db().prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of [
    ["request", "TEXT NOT NULL DEFAULT ''"],
    ["dir", "TEXT NOT NULL DEFAULT ''"],
    ["backend", "TEXT NOT NULL DEFAULT ''"],
    ["ext_id", "TEXT NOT NULL DEFAULT ''"],
    ["stage", "TEXT NOT NULL DEFAULT ''"],
    ["detail", "TEXT NOT NULL DEFAULT ''"],
  ])
    if (!cols.has(name)) db().exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
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

/** 重启时：上次没跑完的（进程没了）记成中断；改自己那件由重启后的结果来收尾，派出去的活由 superagent.ts 的 recoverJobs 按后端各自收尾 */
export function markInterrupted() {
  table();
  db()
    .prepare("UPDATE tasks SET status = 'error', result = '中途重启，没跑完', ended_at = ? WHERE status = 'running' AND kind NOT IN ('repair', 'super')")
    .run(Date.now());
}

/* ─────────── 派出去的活（kind = super）：这张表就是它们的账，内存里只留叫停用的句柄 ─────────── */

/** 走到哪一步：handed 刚交出去 / queued 排队 / working 在干 / asking 在等他回答 / done / failed / stopped */
export type JobStage = "handed" | "queued" | "working" | "asking" | "done" | "failed" | "stopped";
export type JobRow = TaskRow & { request: string; dir: string; backend: string; ext_id: string; stage: JobStage; detail: string };
export type JobEvent = { id: number; task_id: number; at: number; type: string; text: string };

export function createJob(input: { title: string; request: string; dir: string }): number {
  table();
  const id = Number(
    db()
      .prepare("INSERT INTO tasks(kind, title, started_at, request, dir, stage) VALUES('super', ?, ?, ?, ?, 'handed')")
      .run(input.title.slice(0, 80), Date.now(), input.request, input.dir).lastInsertRowid,
  );
  addJobEvent(id, "handed", "交出去了");
  return id;
}

export function updateJob(id: number, patch: Partial<Pick<JobRow, "backend" | "ext_id" | "stage">>) {
  table();
  for (const [k, v] of Object.entries(patch)) db().prepare(`UPDATE tasks SET ${k} = ? WHERE id = ? AND status = 'running'`).run(v, id);
}

/** 还在干的时候，任务栏上那一行写它最近报的进展 */
export function setJobProgress(id: number, text: string) {
  table();
  db().prepare("UPDATE tasks SET result = ? WHERE id = ? AND status = 'running'").run(text.slice(0, 2000), id);
}

export function addJobEvent(taskId: number, type: string, text = "") {
  table();
  db().prepare("INSERT INTO task_events(task_id, at, type, text) VALUES(?, ?, ?, ?)").run(taskId, Date.now(), type, text.slice(0, 4000));
}

/** 收尾：result 是任务栏上那段（可以带文件卡片），detail 是完整回报，留着给他事后追问。已经收过尾的不再动，返回 false */
export function endJob(id: number, stage: "done" | "failed" | "stopped", result: string, detail: string): boolean {
  table();
  const r = db()
    .prepare("UPDATE tasks SET status = ?, stage = ?, result = ?, detail = ?, ended_at = ? WHERE id = ? AND status = 'running'")
    .run(stage === "done" ? "done" : "error", stage, result.slice(0, 2000), detail.slice(0, 60_000), Date.now(), id);
  if (r.changes) addJobEvent(id, stage, detail.slice(0, 600));
  return r.changes > 0;
}

export function getJob(id: number): JobRow | undefined {
  table();
  return db().prepare("SELECT * FROM tasks WHERE id = ? AND kind = 'super'").get(id) as JobRow | undefined;
}

/** 还没收尾的活，从早到晚 */
export function openJobs(): JobRow[] {
  table();
  return db().prepare("SELECT * FROM tasks WHERE kind = 'super' AND status = 'running' ORDER BY id").all() as JobRow[];
}

export function recentJobs(limit = 8): JobRow[] {
  table();
  return db().prepare("SELECT * FROM tasks WHERE kind = 'super' ORDER BY id DESC LIMIT ?").all(limit) as JobRow[];
}

export function jobEvents(taskId: number, limit = 30): JobEvent[] {
  table();
  return (db().prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(taskId, limit) as JobEvent[]).reverse();
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
  // 这些在交出去、做完的时候都已经单独跟他说过了：放在这里是让她心里有数、说话对得上，不是让她每句都汇报一遍
  return [
    running.length ? `后台正在做（交出去时已经跟他说过了，他不问就别再提）：${running.join("；")}。` : "后台现在没有在做的事。",
    done.length ? `最近做完的（结果已经单独告诉过他了，他不问就别再提）：${done.join("；")}。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
