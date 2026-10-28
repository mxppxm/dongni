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
}
