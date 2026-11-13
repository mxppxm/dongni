import "server-only";
import fs from "node:fs";
import path from "node:path";
import { NO_ACTION_PREFIX, runWorker } from "../worker";
import type { Backend, Job, JobHooks } from "./types";

/**
 * 内置执行器（lib/worker.ts）：就在这个进程里跑 agent 循环。
 * superagent 不在线时的退路：不抗重启、没有压缩和子任务，但不依赖任何外部进程。
 */
const MAX_RUNNING = 5;
const TIMEOUT_MS = 25 * 60_000;
const LOGDIR = path.join(process.cwd(), "logs", "super");

/** 等他回答最多这么久，再不回就让它自己保守地往下走 */
const ASK_WAIT_MS = 20 * 60_000;

/** notes：他中途补的话，执行器下一步取走；answer：它正停下来等他回答时，回答从这里送进去 */
type Live = { ac: AbortController; notes: string[]; answer: ((text: string) => void) | null };
const running = ((globalThis as unknown as { __dongniBuiltinLive?: Map<number, Live> }).__dongniBuiltinLive ??= new Map<number, Live>());

export const builtinBackend: Backend = {
  name: "builtin",

  async unavailable() {
    return running.size >= MAX_RUNNING ? `内置执行器已经有 ${running.size} 件在跑` : null;
  },

  start(job: Job, hooks: JobHooks) {
    const ac = new AbortController();
    const live: Live = { ac, notes: [], answer: null };
    running.set(job.id, live);
    hooks.event("working", "内置执行器开始干了", "working");
    fs.mkdirSync(LOGDIR, { recursive: true });
    const trace = path.join(LOGDIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${job.id}.jsonl`);
    // budgetMs 只是让它自己收尾，到 TIMEOUT_MS 还没收就真停
    const arm = () => setTimeout(() => ac.abort(new Error(`超过 ${TIMEOUT_MS / 60_000} 分钟没收尾，强制停下`)), TIMEOUT_MS);
    let hard = arm();
    // 停下来问他：等到回答、等够时间、或者被叫停，三者先到为准。等他的时间不算在干活的时限里
    const ask = (question: string) =>
      new Promise<string>((ok) => {
        clearTimeout(hard);
        const done = (text: string) => {
          if (!live.answer) return;
          live.answer = null;
          clearTimeout(wait);
          ac.signal.removeEventListener("abort", onAbort);
          hard = arm();
          if (text) hooks.event("answer", text, "working");
          else hooks.event("stage", "", "working");
          ok(text);
        };
        const onAbort = () => done("");
        const wait = setTimeout(() => done(""), ASK_WAIT_MS);
        ac.signal.addEventListener("abort", onAbort, { once: true });
        live.answer = done;
        hooks.event("ask", question, "asking");
      });
    void runWorker({
      task: job.request,
      dir: job.dir,
      budgetMs: TIMEOUT_MS - 60_000,
      signal: ac.signal,
      ask,
      progress: (text) => hooks.event("progress", text),
      notes: () => live.notes.splice(0),
      log: (entry) => {
        try {
          fs.appendFileSync(trace, JSON.stringify(entry) + "\n");
        } catch {}
      },
    })
      .then((text) => {
        // 叫停/超期强停：哪怕执行器刚好在这时交了卷，也按「停下了」报
        if (ac.signal.aborted) return hooks.finish("stopped", `中途停下了。它最后说的是：\n${text}`);
        const failed = /^(没做成|步数用完了)/.test(text) || text.startsWith(NO_ACTION_PREFIX);
        hooks.finish(failed ? "failed" : "done", text);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        hooks.finish(ac.signal.aborted ? "stopped" : "failed", ac.signal.aborted ? `中途停下了：${msg}` : `执行器半路出错：${msg}`);
      })
      .finally(() => {
        clearTimeout(hard);
        running.delete(job.id);
      });
  },

  // 循环在进程里，进程没了活就没了
  resume() {
    return false;
  },

  async cancel(job: Job) {
    const live = running.get(job.id);
    if (!live) return "这件活已经不在跑了";
    live.ac.abort(new Error("他叫停了"));
    return null;
  },

  // 它正等着他回答：这句就是回答；否则记下来，它下一步开始前会看到
  async append(job: Job, text: string) {
    const live = running.get(job.id);
    if (!live) return "这件活已经不在跑了";
    if (live.answer) live.answer(text);
    else live.notes.push(text);
    return null;
  },
};

export const builtinRunning = () => running.size;
