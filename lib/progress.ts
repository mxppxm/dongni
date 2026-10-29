import "server-only";
import { getKv, setKv } from "./db";
import { postAssistant, repairRunning } from "./selfrepair";

/**
 * 长时间任务（改自己）一跑就是好几分钟，中间一句话都没有，他看着像掉井里。
 * 这里每隔两三分钟贴一句极短的进度：只一句人话，不提文件、路径、步骤、分钟数。
 *
 * 为什么用 kind=system 贴：界面上是淡淡的一行，不占气泡、不进她的对话记忆，
 * 也不算「他还没回话就追着说」——免得这几句进度把最后那句「改好了」挤掉。
 */

/** 两三分钟一句 */
const EVERY = 150_000;
/** 一次任务最多三句，再多就是吵 */
const MAX_LINES = 3;
const LINES = ["还在改，没停，别急", "还在弄，比想的久一点", "还在改，好了我马上说"];

const state = ((globalThis as unknown as { __dongniProgress?: { timer: NodeJS.Timeout | null } }).__dongniProgress ??= {
  timer: null,
});

/** 到点看一眼：现在真有任务在跑吗、上一句多久之前、这次任务已经贴了几句 */
export function progressTick(now = Date.now()) {
  let running = false;
  try {
    running = !!repairRunning();
  } catch {
    return;
  }
  const startedAt = Number(getKv("repair_started_at") ?? 0);
  if (!running || !startedAt) return; // 没在跑就说不出「进度」，宁可不说
  const task = String(startedAt);
  const sameTask = getKv("progress_task") === task;
  const n = sameTask ? Number(getKv("progress_n") ?? 0) : 0;
  if (n >= MAX_LINES) return;
  // 开头两分钟还在铺场子，先让他看那句「开始改了」
  if (now - startedAt < EVERY) return;
  const lastAt = sameTask ? Number(getKv("progress_last_at") ?? 0) : 0;
  if (lastAt && now - lastAt < EVERY) return;
  const text = LINES[Math.min(n, LINES.length - 1)];
  try {
    postAssistant(text, "system");
  } catch (e) {
    console.warn(`[dongni] 进度那句没贴出去（第 2 步写进对话失手：${e instanceof Error ? e.message : e}）：${text}`);
    return;
  }
  setKv("progress_task", task);
  setKv("progress_n", String(n + 1));
  setKv("progress_last_at", String(now));
  console.log(`[dongni] 进度（第 ${n + 1} 句）：${text}`);
}

/** 启动时挂上：每分钟看一眼，够不够说下一句由 progressTick 自己算 */
export function startProgressTick() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    try {
      progressTick();
    } catch (e) {
      console.warn("[dongni] 进度检查没走通：", e instanceof Error ? e.message : e);
    }
  }, 60_000);
  // 这个定时器不该把进程本身吊着不退出
  state.timer.unref?.();
}