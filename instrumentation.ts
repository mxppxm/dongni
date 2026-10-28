export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { backupDaily } = await import("./lib/db");
  const { runExtraction } = await import("./lib/memory");
  const { resumePending } = await import("./lib/chat");
  const { reportRebuild, drainRepairQueue } = await import("./lib/selfrepair");
  reportRebuild();
  // 排队中的自我修改，等服务稳定后接着做（重编译脚本要先做完体检）
  setTimeout(drainRepairQueue, 90_000);
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
  void ensureWardrobe().then(() => dailyTick());
  setInterval(() => void dailyTick(), 15 * 60_000);
}
