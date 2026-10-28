import { setProfile } from "@/lib/memory";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const { profile } = (await req.json()) as { profile?: string };
  setProfile((profile ?? "").trim());
  return Response.json({ ok: true });
}
