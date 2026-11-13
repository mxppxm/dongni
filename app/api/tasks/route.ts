import { activityOf } from "@/lib/superagent";
import { getJob, jobEvents, listTasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    tasks: listTasks().map((t) => {
      const background = t.kind === "super" || t.kind === "repair";
      // 后台在跑的活（派出去的、改她自己的）：带上它现在的真实动静——第几步、在干什么、多久没动、最近几个动作
      const live = t.status === "running" && background ? activityOf(t.id) : null;
      // 还没人接、还没开工的：说清楚卡在哪一步，别只显示一个转圈
      const stage = t.status === "running" && t.kind === "super" ? (getJob(t.id)?.stage ?? "") : "";
      const lastEvent = t.status === "running" && t.kind === "super" && !live ? (jobEvents(t.id, 1)[0]?.text ?? "") : "";
      return {
        id: t.id,
        kind: t.kind,
        title: t.title,
        status: t.status,
        result: t.result,
        startedAt: t.started_at,
        endedAt: t.ended_at,
        live,
        waiting: !live && t.status === "running" && background ? (stage === "queued" ? "排队等人接" : stage === "asking" ? "在等你回答" : lastEvent || "已经交出去，等后台接单") : "",
      };
    }),
  });
}
