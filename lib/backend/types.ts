import "server-only";
import type { JobStage } from "../tasks";

/**
 * 干活的后端：派出去的活由谁来执行。上层（lib/superagent.ts）只认这组接口，
 * 账记在懂你自己的 tasks 表里——换后端、后端挂了，账都不丢。
 */
export type Job = { id: number; request: string; dir: string; extId: string };

export type JobHooks = {
  /** 后端那边给这件活的编号（任务文件名、工单号），记下来重启后还能找回 */
  ext(extId: string): void;
  /** 中途的事：接单了、通知、在问他…… stage 给了就同时改阶段 */
  event(type: string, text: string, stage?: JobStage): void;
  /** 收尾，只会生效一次 */
  finish(stage: "done" | "failed" | "stopped", text: string): void;
};

export interface Backend {
  readonly name: string;
  /** 现在能不能接活；不能就返回原因 */
  unavailable(): Promise<string | null>;
  /** 开始干；不抛错，出了事走 hooks.finish */
  start(job: Job, hooks: JobHooks): void;
  /** 服务重启后把还开着的活接回来；接不回来返回 false（由上层收尾并告诉他） */
  resume(job: Job, hooks: JobHooks): boolean;
  /** 真的停下；停不了返回原因 */
  cancel(job: Job): Promise<string | null>;
  /** 给正在干的活追加一句要求；做不到返回原因 */
  append(job: Job, text: string): Promise<string | null>;
}
