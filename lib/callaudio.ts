import "server-only";

/**
 * 电话上行（麦克风 → 识别）的节拍器：按真实时间一片片喂，不攒成一坨倒过去。
 *
 * 为什么要有这么个东西：这通电话跟回复生成、工具、记忆整理、画图都住在同一个进程里，
 * 主线程被占住零点几秒（一次同步的图片处理、一次数据库查询、声纹模型算一下），页面送来的
 * PCM 就全堆在手里；等它腾出手来再一股脑转给识别，识别那头收到的就是「被快进的一段声音」——
 * 时间轴一乱，断句、切句跟着错，听感上就是一顿一顿、一句话说不完整。
 * 按真实时间吐出去，多出来的那点时间只会变成几十毫秒的延迟，不会把声音挤变形。
 *
 * 规矩：
 * - 20ms 一帧算账，100ms 一包送；
 * - 落后的额度最多攒两包，不追、不快进（主线程卡住之后也不补发一大串）；
 * - 积压超过上限就从最旧的整帧丢（宁可缺一口气，也不要整段错位）；整帧丢，字节永远落在 16 位边界上。
 */
export type AudioPacer = {
  push(pcm: Buffer): void;
  /** 一共丢了多少毫秒（日志用） */
  droppedMs(): number;
  pendingMs(): number;
  stop(): void;
};

/** 16k、单声道、16 位：20ms = 640 字节，1ms = 32 字节 */
const FRAME_BYTES = 640;
const BYTES_PER_MS = 32;
const CHUNK_BYTES = 3200; // 100ms 一包

export function audioPacer(send: (pcm: Buffer) => void, opts: { maxBacklogMs?: number; tickMs?: number } = {}): AudioPacer {
  const maxBacklog = Math.round((opts.maxBacklogMs ?? 800) * BYTES_PER_MS);
  let acc = Buffer.alloc(0);
  // 一开始就欠一包的额度：攒够 100ms 立刻送出去，别让开头多等一个节拍
  let credit = CHUNK_BYTES;
  let last = Date.now();
  let dropped = 0;

  const tick = () => {
    const now = Date.now();
    const dt = Math.max(0, now - last);
    last = now;
    credit = Math.min(credit + dt * BYTES_PER_MS, CHUNK_BYTES * 2);
    while (credit >= CHUNK_BYTES && acc.length >= CHUNK_BYTES) {
      const out = acc.subarray(0, CHUNK_BYTES);
      acc = acc.subarray(CHUNK_BYTES);
      credit -= CHUNK_BYTES;
      try {
        send(out);
      } catch {
        // 对面断了：这一包丢了就丢了，下一包照旧
      }
    }
    if (acc.length > maxBacklog) {
      const over = acc.length - maxBacklog;
      const cut = Math.min(acc.length, Math.ceil(over / FRAME_BYTES) * FRAME_BYTES);
      acc = acc.subarray(cut);
      dropped += cut;
      credit = 0;
    }
  };

  const timer = setInterval(tick, opts.tickMs ?? 40);
  // 别因为这个小定时器把进程吊着不退出
  timer.unref?.();

  return {
    push(pcm) {
      if (!pcm.length) return;
      acc = acc.length ? Buffer.concat([acc, pcm]) : Buffer.from(pcm);
    },
    droppedMs: () => Math.round(dropped / BYTES_PER_MS),
    pendingMs: () => Math.round(acc.length / BYTES_PER_MS),
    stop() {
      clearInterval(timer);
      acc = Buffer.alloc(0);
    },
  };
}