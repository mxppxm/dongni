import "server-only";
import { db } from "./db";

/**
 * 主动消息的发件箱，现在只用来清理。
 *
 * 定时主动打扰已经关掉（见 lib/proactive.ts），不再有「话想好了却没送进对话」这种情况，
 * 所以也不再往这张表里写。留着这段是因为以前排着队、还没发出去的主动消息还在库里，
 * 启动时（lib/chat.ts 的 resumePending）和主动入口都顺手清干净——免得重启后又冒出来一条。
 * 只删这张队列表，不碰对话本身。
 */

type Row = { n: number };

function ensure() {
  db().exec(`
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
    db().exec("ALTER TABLE proactive_outbox ADD COLUMN step TEXT");
  } catch {}
}

/** 清空还没发出去的主动消息，返回清掉几条 */
export function clearOutbox(): number {
  try {
    ensure();
    const row = db().prepare("SELECT COUNT(*) n FROM proactive_outbox").get() as Row | undefined;
    const n = Number(row?.n ?? 0);
    if (n > 0) {
      db().prepare("DELETE FROM proactive_outbox").run();
      console.log(`[dongni] 清掉 ${n} 条没发出去的主动消息，不再补发`);
    }
    return n;
  } catch (e) {
    console.error("[dongni] 发件箱清不掉：", e instanceof Error ? e.message : e);
    return 0;
  }
}