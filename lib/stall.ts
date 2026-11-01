/**
 * 静默看门狗：一段时间没有任何输出，就当这条连接已经死了，回调一次（只会回调一次）。
 *
 * 为什么需要：pi 自己不设单次请求超时。有一次请求的 socket 挂着不动，
 * 它一声不响干等了 57 分钟，整轮自我修复被拖到 67 分钟，最后才等到
 * "terminated" 再重试。本地编译重启其实只要 12 秒。
 */
export function stallWatchdog(opts: {
  /** 多久没动静算卡死，默认 3 分钟 */
  stallMs?: number;
  /** 检查间隔，默认 10 秒 */
  everyMs?: number;
  /** 返回「最后一次有动静的时间戳」 */
  touch: () => number;
  onStall: () => void;
}): () => void {
  const stallMs = opts.stallMs ?? 180_000;
  const everyMs = opts.everyMs ?? 10_000;
  const timer = setInterval(() => {
    if (Date.now() - opts.touch() < stallMs) return;
    clearInterval(timer);
    opts.onStall();
  }, everyMs);
  // 别让这个定时器把进程吊着不退出
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
