import { selfTest } from "@/lib/chat";
import { streamChat } from "@/lib/llm";

export const dynamic = "force-dynamic";

/**
 * 健康检查（内核文件，自我修复不能改）。
 * 基础项必须过：数据库、提示词组装。模型接口单独报告——接口抽风不算新代码的错，不触发退回。
 */
export async function GET() {
  let base: unknown;
  try {
    base = selfTest();
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
  // 模型只探一下、最多等 8 秒：重启后的体检每次最多等 60 秒，模型慢了不能拖成「不健康」把好好的修改退回去
  const probe = (async () => {
    let text = "";
    for await (const ev of streamChat([{ role: "user", content: "只回复：ok" }])) if (ev.type === "text") text += ev.text;
    return text.trim() ? "ok" : "empty";
  })().catch((e) => `fail: ${e instanceof Error ? e.message : e}`);
  const model = await Promise.race([probe, new Promise<string>((ok) => setTimeout(() => ok("slow（8 秒没回，不影响体检）"), 8000))]);
  return Response.json({ ok: true, base, model });
}

/** 重编译脚本体检通过后调用：把「新版本已生效」告诉用户 */
export async function POST() {
  const { reportRebuild } = await import("@/lib/selfrepair");
  reportRebuild();
  return Response.json({ ok: true });
}
