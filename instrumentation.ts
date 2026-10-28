export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { backupDaily } = await import("./lib/db");
  const { runExtraction } = await import("./lib/memory");
  const { resumePending } = await import("./lib/chat");
  const { reportRebuild } = await import("./lib/selfrepair");
  reportRebuild();
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
}
