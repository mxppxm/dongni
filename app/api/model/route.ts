import { listProfiles, setActiveProfile } from "@/lib/llmconfig";

export const dynamic = "force-dynamic";

/** 右上角菜单里的「模型」：看有哪几条线路、切到哪条。key 不出本机，这里只回名字和模型 */
export async function GET() {
  return Response.json(listProfiles(), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  try {
    setActiveProfile(String(id ?? ""));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  console.log(`[dongni] 模型线路切到「${id}」`);
  return Response.json(listProfiles());
}
