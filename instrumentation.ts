export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { backupDaily } = await import("./lib/db");
  const { runExtraction } = await import("./lib/memory");
  const { resumePending } = await import("./lib/chat");
  const { reportRebuild, drainRepairQueue } = await import("./lib/selfrepair");
  (await import("./lib/tasks")).markInterrupted();
  // 后台干活的 superagent：没在跑就顺手拉起来（已经在跑不会起第二个；他手动停过就不拉）
  void (await import("./lib/backend/dsh")).dshBackend.unavailable().then((why) => {
    if (why) console.log(`[dongni][dsh] 启动时：${why}`);
  });
  // 派出去的活：superagent 那边的接着盯，跟着进程没了的照实告诉他
  (await import("./lib/superagent")).recoverJobs();
  reportRebuild();
  // 后来学会的本事（插件）：启动时扫一遍，启用着的试跑、MCP 型的把服务连上
  try {
    (await import("./lib/tools")).extraStateLines();
  } catch {}
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
