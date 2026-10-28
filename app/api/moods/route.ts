import { listMoods, moodUrl } from "@/lib/moods";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ moods: listMoods().map((m) => ({ key: m.key, name: m.name, url: moodUrl(m), preset: m.preset, fx: m.fx })) });
}
