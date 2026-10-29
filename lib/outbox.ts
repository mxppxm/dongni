import "server-only";
import { db } from "./db";

/**
 * 主动消息的发件箱：话已经想好了，写进对话那一步却断了（库被锁、进程正好在重启），
 * 以前就整条静默消失——说完话像掉进井里，他自己也不知道到底说没说。
 * 现在断在哪一步都在日志里写清，没落进对话的先存这张表，重启后补发一次。
 */

/** 隔太久的老话就不补了：半天以后突然冒出一句前面的事，反而莫名其妙 */
const KEEP_MS = 12 * 3600_000;

export type OutboxRow = {
  id: number;
  content: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
  /** 断在哪一步（哪个调用），事后查日志时能直接对上 */
  step: string | null;
};

function ensure() {
  const d = db();
  d.exec(`
    CREATE TABLE IF NOT EXISTS proactive_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      step TEXT
    );
  `);
  // 上一版建的表没有 step 列：补一列，已经有了就报错，忽略
  try {
    d.exec("ALTER TABLE proactive_outbox ADD COLUMN step TEXT");
  } catch {}
}

/** 同步小睡：等一下再试（这里是同步流程，不能 await） */
function nap(ms: number) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

/** 这句话没送出去：存进发件箱，日志里留下是哪一步、断在哪儿 */
export function enqueueProactive(text: string, step: string, e: unknown) {
  const why = e instanceof Error ? e.message : String(e);
  console.error(`[dongni] 主动消息没发出去——${step} 失手（${why}），已存进发件箱，重启后补发一次：${text}`);
  // 第 2 步常常是因为库被锁/正在重启才失手，同一瞬间再写队列也可能写不进去：试三次再认输
  let lastErr = "";
  for (let i = 0; i < 3; i++) {
    try {
      ensure();
      db().prepare("INSERT INTO proactive_outbox(content, created_at, step) VALUES(?, ?, ?)").run(text, Date.now(), step);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      nap(80 * (i + 1));
    }
  }
  // 连发件箱都写不进去：至少把整句话留在日志里，别真弄丢了
  console.error(`[dongni] 发件箱也没写进去（${step} 之后；${lastErr}），这句话只剩日志里这一份：${text}`);
}

/**
 * 补发：每条只补一次——发成了就删；补发又失败也删，不再无限重试（不然同一句会一直往外冒）。
 * 启动时补一次（见 lib/chat.ts 的 resumePending），主动思考时也顺手补一次。
 */
export function flushOutbox() {
  let rows: OutboxRow[] = [];
  try {
    ensure();
    rows = db().prepare("SELECT * FROM proactive_outbox ORDER BY id").all() as OutboxRow[];
  } catch (e) {
    console.error("[dongni] 发件箱打不开，这次不补发：", e instanceof Error ? e.message : e);
    return;
  }
  if (!rows.length) return;
  const now = Date.now();
  for (const r of rows) {
    const giveUp = (why: string) => {
      try {
        db().prepare("DELETE FROM proactive_outbox WHERE id = ?").run(r.id);
      } catch (e) {
        console.error(`[dongni] 发件箱这条清不掉（${e instanceof Error ? e.message : e}）：${r.content}`);
      }
      console.log(`[dongni] 发件箱不补了（${why}）：${r.content}`);
    };
    const broke = r.step ? `（当初断在${r.step}）` : "";
    if (r.attempts >= 1) {
      giveUp(`已经补发过一次${broke}${r.last_error ? `，上次补发还是失败：${r.last_error}` : ""}`);
      continue;
    }
    if (now - r.created_at > KEEP_MS) {
      giveUp(`放太久了，现在补上一句反而突兀${broke}`);
      continue;
    }
    try {
      db()
        .prepare("INSERT INTO messages(role, content, status, extracted, created_at) VALUES('assistant', ?, 'done', 1, ?)")
        .run(r.content, now);
      db().prepare("DELETE FROM proactive_outbox WHERE id = ?").run(r.id);
      console.log(
        `[dongni] 发件箱补发成功（${Math.max(1, Math.round((now - r.created_at) / 60000))} 分钟前没发出去的那句${broke}）：${r.content}`,
      );
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`[dongni] 补发失败——第 2 步 写进对话（INSERT messages）失手（${why}），不再重试：${r.content}`);
      try {
        db().prepare("UPDATE proactive_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?").run(why, r.id);
      } catch {}
    }
  }
}