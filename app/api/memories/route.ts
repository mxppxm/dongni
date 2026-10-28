import { db } from "@/lib/db";
import { activeMemories, allLinks, getProfile } from "@/lib/memory";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const mems = activeMemories();
  if (new URL(req.url).searchParams.get("count")) return Response.json({ count: mems.length });
  return Response.json({
    profile: getProfile(),
    memories: mems.map((m) => {
      // 触发这条记忆的那句话，以及她当时怎么回的
      const src = m.source_message_id
        ? (db().prepare("SELECT content, created_at FROM messages WHERE id = ?").get(m.source_message_id) as
            | { content: string; created_at: number }
            | undefined)
        : undefined;
      const reply = m.source_message_id
        ? (db()
            .prepare("SELECT content FROM messages WHERE id > ? AND role = 'assistant' AND status = 'done' ORDER BY id LIMIT 1")
            .get(m.source_message_id) as { content: string } | undefined)
        : undefined;
      return {
        id: m.id,
        content: m.content,
        category: m.category,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        source: src ? { text: src.content, at: src.created_at, reply: reply?.content ?? null } : null,
      };
    }),
    links: allLinks(),
  });
}
