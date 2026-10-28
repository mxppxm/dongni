import { db, type MessageRow } from "@/lib/db";

export const dynamic = "force-dynamic";

const pick = (m: MessageRow) => ({
  id: m.id,
  clientId: m.client_id,
  role: m.role,
  content: m.content,
  status: m.status,
  createdAt: m.created_at,
});

/** ?before=id 往前翻页；?after=id 取之后的（含状态更新） */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const before = Number(url.searchParams.get("before") || 0);
  const after = url.searchParams.get("after");
  const limit = Math.min(200, Number(url.searchParams.get("limit") || 60));
  let rows: MessageRow[];
  if (after !== null) {
    rows = db().prepare("SELECT * FROM messages WHERE id >= ? ORDER BY id LIMIT 200").all(Number(after)) as MessageRow[];
  } else if (before) {
    rows = (db().prepare("SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, limit) as MessageRow[]).reverse();
  } else {
    rows = (db().prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?").all(limit) as MessageRow[]).reverse();
  }
  const hasMore =
    after === null && rows.length > 0 && !!db().prepare("SELECT 1 FROM messages WHERE id < ? LIMIT 1").get(rows[0].id);
  return Response.json({ messages: rows.map(pick), hasMore });
}
