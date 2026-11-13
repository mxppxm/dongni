import { activityLine } from "@/lib/superagent";
import { listTasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    tasks: listTasks().map((t) => {
      // 后台在跑的活（派出去的、改她自己的）：结果那一栏先放它现在的真实动静——第几步、在干什么、多久没动了
      const live = t.status === "running" && (t.kind === "super" || t.kind === "repair") ? activityLine(t.id) : "";
      return {
        id: t.id,
        kind: t.kind,
        title: t.title,
        status: t.status,
        result: live || t.result,
        startedAt: t.started_at,
        endedAt: t.ended_at,
      };
    }),
  });
}
