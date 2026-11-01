import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getKv, setKv } from "./db";
import { LLM_CONFIG } from "./portable";
import { postAssistant } from "./selfrepair";
import { speakAsHer } from "./speak";
import { runWorker } from "./worker";
import { finishTask, startTask } from "./tasks";

/**
 * 派活：把一件「大到一次对话里干不完」的事交给内置执行器（lib/worker.ts：DeepSeek 跑 agent
 * 循环，自己读写文件、跑命令），不再外挂 clacky CLI。
 * 小活不派——她自己去查、去写、去改（repair_self 走 pi），派出去反而慢、反而贵。
 *
 * 判断在 judge() 里，是打分的：命中越多越复杂。派不派由分数决定，不由心情决定。
 */
const HOME = os.homedir();
const ROOT = process.cwd();
const LOGDIR = path.join(ROOT, "logs", "super");
const MAX_RUNNING = 2;
const TIMEOUT_MS = 25 * 60_000;

// ─────────────────────────── 判断：这活该谁干 ───────────────────────────

export type Level = "simple" | "medium" | "complex";
export type Target = "self" | "pi" | "super";
export type Judgement = { level: Level; target: Target; score: number; reasons: string[] };

/** 复杂的信号：一旦命中就是「一个人边聊边干不完」的活 */
const COMPLEX_HINTS: { re: RegExp; w: number; why: string }[] = [
  { re: /重构|架构|迁移|升级依赖|换掉|大改/, w: 2, why: "要动整体结构" },
  { re: /部署|上线|发版|打包|服务器|域名|CI|流水线/, w: 2, why: "涉及部署链路" },
  { re: /调研|对比|选型|评估|写份报告|出个方案|市场|竞品/, w: 2, why: "要查资料、要多轮取证" },
  { re: /批量|所有文件|整个项目|整个仓库|全站|全量|从头搭|从零/, w: 2, why: "面铺得很大" },
  { re: /爬|抓取|脚本化|自动化|定时任务流|监控/, w: 1, why: "要写能跑起来的程序" },
  { re: /端到端|联调|调试一遍|排查|复现|压测|性能优化/, w: 2, why: "要多轮试错" },
  { re: /多个文件|好几个文件|三个页面|一套|系统|平台|后台管理|小程序|网站|App/i, w: 2, why: "产物不是一个文件" },
  { re: /然后|接着|再帮我|顺便|另外|第一步|第二步|1[.、]|2[.、]/, w: 1, why: "一句话里塞了好几件事" },
];

/** 简单的信号：命中就往下压 */
const SIMPLE_HINTS: { re: RegExp; w: number; why: string }[] = [
  { re: /^(查一下|看看|打开|念一下|翻译|算一下|几点了|提醒我)/, w: 2, why: "一句话就能办完" },
  { re: /光看|只问|随便聊|讲个|说个/, w: 2, why: "只是聊天" },
  { re: /这个文件|这段话|这张图|这一句/, w: 1, why: "对象就一个" },
];

/** 中等：改她自己、修她自己的毛病——这条路走 pi，不占 super agent */
const PI_HINTS = /你自己|改自己|你的界面|你的样式|你说话|你的语气|你回复|app里|这个应用|加个功能|去个功能|按钮|颜色/;

export function judge(task: string, opts: { force?: boolean } = {}): Judgement {
  const t = (task || "").trim();
  const reasons: string[] = [];
  let score = 0;
  for (const h of COMPLEX_HINTS) {
    if (h.re.test(t)) {
      score += h.w;
      reasons.push(`+${h.w} ${h.why}`);
    }
  }
  for (const h of SIMPLE_HINTS) {
    if (h.re.test(t)) {
      score -= h.w;
      reasons.push(`-${h.w} ${h.why}`);
    }
  }
  const items = t.split(/[，。;；、]|\band\b/).filter((s) => s.trim().length > 3).length;
  if (t.length > 120) {
    score += 1;
    reasons.push("+1 一句话说不完，得展开");
  }
  if (items >= 3) {
    score += 1;
    reasons.push(`+1 拆出 ${items} 件事`);
  }
  if (/https?:\/\//.test(t)) {
    score += 1;
    reasons.push("+1 要上网看东西");
  }
  const piish = PI_HINTS.test(t) && !/部署|上线|调研|整个项目/.test(t);
  if (piish) {
    score -= 1;
    reasons.push("-1 改的是我自己，交给 pi 更稳");
  }

  let level: Level = score >= 4 ? "complex" : score >= 1 ? "medium" : "simple";
  if (piish && level === "medium") level = "medium";
  let target: Target = level === "complex" ? "super" : piish ? "pi" : level === "medium" ? "pi" : "self";
  if (opts.force) {
    level = "complex";
    target = "super";
    reasons.push("他明确要求派出去（force）");
  }
  return { level, target, score, reasons };
}

// ─────────────────────────── 派出去 ───────────────────────────

type Job = { id: string; task: string; dir: string; since: number };
const state = ((globalThis as unknown as { __dongniSuper?: { jobs: Map<string, Job> } }).__dongniSuper ??= {
  jobs: new Map<string, Job>(),
});

function log(line: string) {
  fs.mkdirSync(LOGDIR, { recursive: true });
  fs.appendFileSync(path.join(LOGDIR, "dispatch.log"), `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${line}\n`);
}

export function runningJobs(): Job[] {
  // 进程被重启、runJob 半路炸掉，都可能留下永远「在跑」的僵尸条目；超时的直接清掉，
  // 不然 MAX_RUNNING 被它们占满，后面每件都只能回「先排队」，他那边看到的就是「说了派人但啥也没动」。
  for (const [id, j] of state.jobs) {
    if (Date.now() - j.since > TIMEOUT_MS + 5 * 60_000) {
      state.jobs.delete(id);
      log(`${id} 超期没动静，从在跑名单里清掉`);
    }
  }
  return [...state.jobs.values()];
}

/** 工作目录：默认主目录；给了就以给了的为准，但不许出主目录，也不许进凭证目录 */
function safeDir(dir?: string): string {
  if (!dir?.trim()) return HOME;
  const abs = path.resolve(dir.replace(/^~/, HOME));
  if (!abs.startsWith(HOME)) throw new Error("只能在他自己的主目录里干活。");
  if (/\/\.(ssh|gnupg|aws|kube|pi|clacky)(\/|$)/.test(abs)) throw new Error("这个目录里是密钥/配置，不进去。");
  if (!fs.existsSync(abs)) throw new Error(`这个目录不存在：${abs}`);
  return abs;
}

/** 后台把它跑掉：跑完用她自己的口吻把结果说进对话里 */
export function dispatch(task: string, dir?: string): string {
  const t = (task || "").trim();
  if (!t) return "要派什么活得说清楚。";
  const running = runningJobs().length;
  if (running >= MAX_RUNNING) return `现在已经有 ${running} 件在 super agent 上跑着，这件先排队，等他问起来再说。`;

  const cwd = safeDir(dir);
  const id = `S${Date.now().toString().slice(-6)}`;
  const job: Job = { id, task: t, dir: cwd, since: Date.now() };
  state.jobs.set(id, job);
  setKv(
    "super_jobs",
    JSON.stringify([...state.jobs.values()].map((j) => ({ id: j.id, task: j.task.slice(0, 60), dir: j.dir, since: j.since }))),
  );
  log(`==== ${id} 开始｜目录 ${cwd}｜${t}`);

  const taskId = startTask("super", `交给 super agent：${t.replace(/\s+/g, " ").slice(0, 26)}`);
  void runJob(job, taskId).catch((e) => {
    // runJob 自己不该抛；真抛了也不能让这件活从名单里消失（名额被占满，后面全变「先排队」）
    const msg = e instanceof Error ? e.message : String(e);
    state.jobs.delete(job.id);
    setKv(
      "super_jobs",
      JSON.stringify([...state.jobs.values()].map((j) => ({ id: j.id, task: j.task.slice(0, 60), dir: j.dir, since: j.since }))),
    );
    log(`${id} 半路炸了：${msg}`);
    finishTask(taskId, false, msg.slice(0, 400));
    try {
      postAssistant(`那件事没跑起来（${id}）：${msg}`);
    } catch {}
  });
  // 措辞要诚实：这一步只知道「活登记上了」，还没证明它真干成。以前一律回「派出去了」，
  // 结果执行器一启动就崩，她还照着这句话跟他说「已经交出去了」。
  return `接下来我自己干（${id}），在 ${cwd.replace(HOME, "~")} 里，一步一步来，跑完把结果说给你。${
    dir?.trim() ? "" : "（他没给目录，我默认在主目录里干；要是这活属于某个项目，把 dir 传进来。）"
  }这活要几分钟，不用一直等，也别用「已经交出去了」这种说法，就说「我自己上手了，正在弄」。`;
}

async function runJob(job: Job, taskId: number) {
  const trace = path.join(LOGDIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const t0 = Date.now();
  let failed = false;
  let text = "";
  try {
    text = await runWorker({
      task: job.task,
      dir: job.dir,
      budgetMs: TIMEOUT_MS - 60_000,
      log: (entry) => {
        try {
          fs.appendFileSync(trace, JSON.stringify(entry) + "\n");
        } catch {}
      },
    });
    if (/^(没做成|步数用完了|那件事没跑起来)/.test(text)) failed = true;
  } catch (e) {
    failed = true;
    const msg = e instanceof Error ? e.message : String(e);
    text = `执行器半路出错：${msg}`;
    log(`${job.id} 抛错：${msg}`);
  }
  const ok = !failed;
  setKv("super_last", JSON.stringify({ id: job.id, at: Date.now(), ok, text: text.slice(0, 2000) }));
  log(`${job.id} 结束｜${ok ? "ok" : "失败"}｜用时 ${Math.round((Date.now() - t0) / 1000)} 秒｜${text.slice(0, 300)}`);
  finishTask(taskId, ok, text.slice(0, 400));

  const short = text.length > 700 ? text.slice(0, 700) + "\n……（后面还有，日志里有）" : text;
  // 兜底句必须自带正文：说不上话的时候，用户至少能看到到底做成了什么
  const fallback = ok ? `那件事办完了，它是这么说的：\n\n${short}` : `那件事没办成，它是这么说的：\n\n${short}`;
  try {
    const said = await speakAsHer(`你让 super agent 干的那件事（${job.task.slice(0, 40)}）回来了，结果原文是：\n${short}`, fallback, {
      fresh: true,
    });
    postAssistant(said && said.trim() ? said : fallback);
  } catch (e) {
    log(`${job.id} 结果没能说进对话：${e instanceof Error ? e.message : e}`);
    // 兜嘴说不了话，也得把结果原样贴进对话，不能凭空消失
    try {
      postAssistant(fallback);
    } catch (e2) {
      log(`${job.id} 兜底也没贴进去：${e2 instanceof Error ? e2.message : e2}`);
    }
  }
}
