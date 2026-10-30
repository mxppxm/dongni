import { listTasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    tasks: listTasks().map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      status: t.status,
      result: t.result,
      startedAt: t.started_at,
      endedAt: t.ended_at,
    })),
  });
}
