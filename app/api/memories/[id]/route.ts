import { db } from "@/lib/db";
import { CATEGORIES } from "@/lib/memory";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { content, category } = (await req.json()) as { content?: string; category?: string };
  if (!content?.trim()) return Response.json({ error: "内容为空" }, { status: 400 });
  const cat = category && (CATEGORIES as readonly string[]).includes(category) ? category : null;
  db()
    .prepare("UPDATE memories SET content = ?, category = COALESCE(?, category), updated_at = ? WHERE id = ?")
    .run(content.trim(), cat, Date.now(), Number(id));
  return Response.json({ ok: true });
}

/** 软删除：只是不再使用，库里留底 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  db().prepare("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?").run(Date.now(), Number(id));
  return Response.json({ ok: true });
}
