import "server-only";
import { clearOutbox } from "./outbox";

/**
 * 定时「主动找你」已经彻底关掉。
 *
 * 以前启动钩子（instrumentation.ts）每 15 分钟调一次 proactiveTick()，让她自己判断
 * 「这会儿要不要主动发一条」——结果就成了每隔一刻钟的打扰：他睡觉、开会、干活的时候
 * 都会被弹系统通知。那个周期调用还在，但这里什么都不做了：不想、不发、不弹通知。
 *
 * 跟这里无关的照旧：到点提醒（lib/reminders.ts）、每天的日记和照片（lib/diary.ts、
 * lib/wardrobe.ts）、整库备份（lib/db.ts）都各自管各自的定时器，不受影响。
 *
 * 以前排着队、还没送进对话的主动消息也一并清掉（lib/outbox.ts），免得多一次重启后又冒出来。
 */

const state = ((globalThis as unknown as { __dongniProactive?: { off: boolean } }).__dongniProactive ??= {
  off: false,
});

export function proactiveTick(): void {
  if (state.off) return;
  state.off = true;
  let dropped = 0;
  try {
    dropped = clearOutbox();
  } catch {
    // 清不掉也不影响「已经关掉」这件事：下次进来还会再清一次
    state.off = false;
    return;
  }
  console.log(
    `[dongni] 定时主动打扰已关闭：不再周期性地主动发消息、弹通知${dropped ? `；顺手清掉 ${dropped} 条没发出去的旧消息` : ""}`,
  );
}