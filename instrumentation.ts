export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { backupDaily } = await import("./lib/db");
  const { runExtraction } = await import("./lib/memory");
  const { resumePending } = await import("./lib/chat");
  const { reportRebuild, drainRepairQueue } = await import("./lib/selfrepair");
  (await import("./lib/tasks")).markInterrupted();
  reportRebuild();
  // 打电话：本机 3940 端口的中转
  (await import("./lib/callserver")).startCallServer();
  // 排队中的自我修改：重启 20 秒后接着做（体检一般十几秒就做完）
  setTimeout(drainRepairQueue, 20_000);
  resumePending();
  const tick = () => {
    backupDaily().catch((e) => console.error("[dongni] 备份失败：", e));
    void runExtraction();
  };
  tick();
  setInterval(tick, 10 * 60_000);

  // 主动找对方：每 15 分钟想一次（规矩在 lib/proactive.ts 里卡着，不会打扰）
  const { proactiveTick } = await import("./lib/proactive");
  setTimeout(() => void proactiveTick(), 3 * 60_000);
  setInterval(() => void proactiveTick(), 15 * 60_000);

  // 衣橱：缺的定妆照补上；相册：白天他来过就拍今天这张
  const { ensureWardrobe, dailyTick } = await import("./lib/wardrobe");
  // 她自己的日记：每天一篇
  const { diaryTick } = await import("./lib/diary");
  // 拍照和写日记各管各的：拍照那边模型超时，不能把这一轮的日记也带没了
  const photoAndDiary = () => {
    dailyTick().catch((e) => console.error("[dongni] 今天的照片没弄成：", e));
    diaryTick().catch((e) => console.error("[dongni] 日记没写成：", e));
  };
  void ensureWardrobe()
    .catch((e) => console.error("[dongni] 衣橱准备失败：", e))
    .then(photoAndDiary);
  setInterval(photoAndDiary, 15 * 60_000);
}
