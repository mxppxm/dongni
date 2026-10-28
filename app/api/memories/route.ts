import { activeMemories, allLinks, getProfile } from "@/lib/memory";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const mems = activeMemories();
  if (new URL(req.url).searchParams.get("count")) return Response.json({ count: mems.length });
  return Response.json({
    profile: getProfile(),
    memories: mems.map((m) => ({ id: m.id, content: m.content, category: m.category, createdAt: m.created_at, updatedAt: m.updated_at })),
    links: allLinks(),
  });
}
