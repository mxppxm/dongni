import { firedReminders, pendingReminders } from "@/lib/reminders";

export const dynamic = "force-dynamic";

const pick = (r: { id: number; text: string; at: number; firedAt: number | null }) => ({
  id: r.id,
  text: r.text,
  at: r.at,
  firedAt: r.firedAt,
});

/** pending：还没到点的；fired：最近触发过的（前端拿去弹提醒） */
export async function GET() {
  return Response.json({ pending: pendingReminders().map(pick), fired: firedReminders().map(pick) });
}