import { listPluginsForPage, managePluginFromPage } from "@/lib/tools";

export const dynamic = "force-dynamic";

/** 「本事」面板：她后来学会的每件本事、状态、要的权限、用过几次 */
export async function GET() {
  return Response.json({ plugins: listPluginsForPage() });
}

/** 面板上的开关：启用（他亲手点的，就是点头）、停用、卸载、退回上一版 */
export async function POST(req: Request) {
  const { id, action } = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  if (!id || !["enable", "disable", "remove", "rollback"].includes(String(action))) return Response.json({ error: "参数不对" }, { status: 400 });
  const message = managePluginFromPage(action as "enable" | "disable" | "remove" | "rollback", id);
  return Response.json({ ok: !message.startsWith("出错了"), message, plugins: listPluginsForPage() });
}
