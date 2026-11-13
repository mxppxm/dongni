import "server-only";

/**
 * 一条路：她说的每一句话都在这一条队里一句一句来——不管是回他的话，还是后台的事有了结果要告诉他。
 * 前一句说完、写进库，下一句才轮到。后台的汇报也排这条队，就不会插在她正说到一半的回复中间。
 */
const lane = ((globalThis as unknown as { __dongniLane?: { tail: Promise<unknown> } }).__dongniLane ??= { tail: Promise.resolve() });

export function inLane<T>(job: () => Promise<T>): Promise<T> {
  const run = lane.tail.then(job, job);
  lane.tail = run.catch(() => {});
  return run;
}
