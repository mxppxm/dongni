import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinBackend } from "./backend/builtin";
import { dshBackend } from "./backend/dsh";
import type { Backend, Job, JobHooks } from "./backend/types";
import { inLane } from "./lane";
import { notify, onBack, pageVisible } from "./notify";
import { onCall } from "./presence";
import { postAssistant } from "./selfrepair";
import { speakAsHer } from "./speak";
import { addJobEvent, createJob, endJob, getJob, jobEvents, openJobs, recentJobs, setJobProgress, updateJob, type JobRow, type JobStage } from "./tasks";

/**
 * 派活：把一件「一次对话里干不完」的事交给后台。
 *
 * 派不派由她自己判断（以前这里有一张关键词打分表，4 分以上才真派，结果「把测试跑一遍」这种活 0 分被挡回前台，
 * 而前台根本没有跑命令的工具）。这里只管三件事：
 * - 记账：每件活一行，记在 tasks 表里（lib/tasks.ts），重启不丢，事后能追问；
 * - 找人干：先找 DSH superagent（lib/backend/dsh.ts），它不在线就用内置执行器（lib/backend/builtin.ts），都接不了就排队；
 * - 回话：接单、提问、做完、没做成，用她的口吻说进对话；他不在页面跟前就弹通知；产物挂成文件卡片。
 */
const HOME = os.homedir();
const ROOT = process.cwd();
const LOGDIR = path.join(ROOT, "logs", "super");
/** 先问谁：排前面的不在线，才轮到后面的 */
const BACKENDS: Backend[] = [dshBackend, builtinBackend];
const byName = (name: string) => BACKENDS.find((b) => b.name === name);
const QUEUE_RETRY_MS = 30_000;

/** away：他不在跟前时有了结果的那些活，回来时带一句；hooked：回来的钩子挂过没有 */
const state = ((globalThis as unknown as { __dongniDispatch?: { retry: NodeJS.Timeout | null; away: string[]; hooked: boolean } }).__dongniDispatch ??= {
  retry: null,
  away: [],
  hooked: false,
});

/** 他现在在不在跟前：在打电话，或者聊天页就在眼前 */
const present = () => onCall() || pageVisible();

function log(line: string) {
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.appendFileSync(path.join(LOGDIR, "dispatch.log"), `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${line}\n`);
  } catch {}
}

const STAGE_TEXT: Record<JobStage, string> = {
  handed: "刚交出去",
  queued: "排队等着",
  working: "在干",
  asking: "在等他回答一个问题",
  done: "做完了",
  failed: "没做成",
  stopped: "被停下了",
};
const BACKEND_TEXT: Record<string, string> = { dsh: "superagent", builtin: "内置执行器", "": "还没人接" };

const asJob = (r: JobRow): Job => ({ id: r.id, request: r.request, dir: r.dir, extId: r.ext_id });
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const mins = (from: number) => Math.max(1, Math.round((Date.now() - from) / 60_000));

/** 工作目录：默认主目录；给了就以给了的为准，但不许出主目录、不许进凭证目录，也不许进她自己的代码目录 */
function safeDir(dir?: string): string {
  if (!dir?.trim()) return HOME;
  const abs = path.resolve(dir.trim().replace(/^~(?=\/|$)/, HOME));
  if (abs !== HOME && !abs.startsWith(HOME + path.sep)) throw new Error("只能在他自己的主目录里干活。");
  if (/\/\.(ssh|gnupg|aws|kube|pi|clacky|dsh)(\/|$)/.test(abs)) throw new Error("这个目录里是密钥/配置，不进去。");
  if (abs === ROOT || abs.startsWith(ROOT + path.sep)) throw new Error("这是你自己的代码目录，后台的活不进来改；要改自己用 repair_self。");
  if (!fs.existsSync(abs)) throw new Error(`这个目录不存在：${abs}`);
  return abs;
}

/** 回报里提到的、真实存在的文件：挂成文件卡片，他点一下就能看到东西在哪 */
function artifactCards(text: string, dir: string): string {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:~\/|\/Users\/|\.\/)?[^\s`'"“”‘’（）()，。；：<>\[\]]+\.[A-Za-z0-9]{1,8}/g)) {
    const raw = m[0].replace(/[.,;:]+$/, "");
    const abs = raw.startsWith("~/") ? path.join(HOME, raw.slice(2)) : path.isAbsolute(raw) ? raw : path.resolve(dir, raw);
    if (found.size >= 4) break;
    if (!abs.startsWith(HOME + path.sep) || /\/\.(ssh|gnupg|aws|kube)(\/|$)|\/node_modules\//.test(abs)) continue;
    try {
      if (fs.statSync(abs).isFile()) found.add(abs);
    } catch {}
  }
  return [...found].map((p) => "```card\n" + JSON.stringify({ type: "file", path: p }) + "\n```").join("\n\n");
}

/**
 * 必须送到的话（做完、没做成、被停、要他拿主意）：用她的口吻说进对话，说不出来就原样贴兜底。
 * - 排进回复那条队里再写进对话，不会插在她正说到一半的回复中间；
 * - 在打电话：直接写进对话，电话那头看到新消息会等她嘴空了念出来（电话里的出声顺序归电话那边管）；
 * - 他不在跟前：弹通知，并记一笔，等他回来带一句。
 */
async function tell(brief: string, fallback: string, cards = "", title = "") {
  let said = "";
  try {
    said = (await speakAsHer(brief, fallback, { fresh: true })).trim();
  } catch {}
  const text = said || fallback;
  const post = async () => {
    try {
      postAssistant(cards ? `${text}\n\n${cards}` : text);
    } catch (e) {
      log(`话没能写进对话：${e instanceof Error ? e.message : e}`);
    }
  };
  if (onCall()) await post();
  else await inLane(post);
  if (!present()) {
    if (title) state.away.push(title);
    notify(text);
  }
}

/** 顺带一提的事（接单了、它发来的通知）：他在跟前才贴一行淡淡的系统消息，原话照贴；不在就只记在这件活的记录里 */
function mention(text: string) {
  if (!present() || !text.trim()) return;
  void inLane(async () => {
    try {
      postAssistant(text.trim().slice(0, 400), "system");
    } catch {}
  });
}

/** 他回到跟前：不在的这段时间有好几件活有了结果，带一句，别让他自己往上翻着数 */
function whenBack() {
  const done = state.away.splice(0);
  if (done.length < 2) return; // 就一件：那条消息和通知已经够了
  const names = done.map((t) => `「${t}」`).join("、");
  void (async () => {
    let said = "";
    try {
      said = (
        await speakAsHer(
          `他刚回到电脑前。他不在的这段时间，后台有 ${done.length} 件事有了结果：${names}，每件的结果你前面已经单独说过了。用一句话告诉他这几件都有结果了、往上翻就能看到，别重复细节。`,
          `你不在的时候有 ${done.length} 件事有了结果：${names}，都在上面。`,
          { fresh: true },
        )
      ).trim();
    } catch {}
    await inLane(async () => postAssistant(said || `你不在的时候有 ${done.length} 件事有了结果：${names}，都在上面。`));
  })();
}

function ensureBackHook() {
  if (state.hooked) return;
  state.hooked = true;
  onBack(whenBack);
}

function hooksFor(id: number): JobHooks {
  return {
    ext: (extId) => updateJob(id, { ext_id: extId }),
    event: (type, text, stage) => {
      const job = getJob(id);
      if (!job || job.status !== "running") return;
      if (stage && stage !== job.stage) updateJob(id, { stage });
      if (type === "stage") return; // 只是阶段变了，不算一件事
      addJobEvent(id, type, text);
      log(`#${id} ${type}｜${clean(text).slice(0, 200)}`);
      const what = clean(job.request).slice(0, 40);
      // 进展：记下来、任务栏上能看到；不主动说，他问起来（dispatch_status）才讲
      if (type === "progress") setJobProgress(id, text);
      else if (type === "ack") mention(`后台接单了：${clean(text)}`);
      else if (type === "notice") mention(clean(text));
      else if (type === "ask")
        void tell(
          `你后台在做的那件事（${what}）干到一半，停下来等他拿个主意。问题原文是：\n${text.slice(0, 800)}\n把这个问题用你的话问他，问清楚，别替他答。他回答之后你要用 task_append 把回答转给后台。`,
          `那件事（${what}）要你拿个主意：\n\n${text.slice(0, 800)}`,
          "",
          what,
        );
    },
    finish: (stage, text) => void finish(id, stage, text),
  };
}

async function finish(id: number, stage: "done" | "failed" | "stopped", text: string) {
  const job = getJob(id);
  if (!job) return;
  const cards = stage === "done" ? artifactCards(text, job.dir) : "";
  const short = text.length > 700 ? text.slice(0, 700) + "\n……（后面还有）" : text;
  // 收尾只生效一次：叫停之后执行器又交了卷、重复的回复，都到此为止
  if (!endJob(id, stage, cards ? `${short.slice(0, 1200)}\n\n${cards}` : short, text)) return;
  log(`#${id} 结束｜${STAGE_TEXT[stage]}｜${BACKEND_TEXT[job.backend] ?? job.backend}｜用时 ${Math.round((Date.now() - job.started_at) / 1000)} 秒｜${clean(text).slice(0, 300)}`);
  const what = job.request.slice(0, 60);
  if (stage === "stopped")
    await tell(
      `你后台干的那件事（${what}）被停下了，没做完，别说成办完了。停下时的情况：\n${short}`,
      `那件事停下了，没做完：\n\n${short}`,
      "",
      clean(what).slice(0, 30),
    );
  else if (stage === "done")
    await tell(
      `你后台干的那件事（${what}）做完了，结果原文是：\n${short}\n${cards ? "产物的文件卡片会自动贴在你这句话后面，你不用说路径。" : ""}`,
      `那件事办完了：\n\n${short}`,
      cards,
      clean(what).slice(0, 30),
    );
  else await tell(`你后台干的那件事（${what}）没做成，原因原文是：\n${short}\n照实告诉他卡在哪。`, `那件事没办成：\n\n${short}`, "", clean(what).slice(0, 30));
  void drainQueue();
}

/** 找个能接的后端把这件活交出去；都接不了就排着，过一阵再问 */
async function place(id: number): Promise<void> {
  const row = getJob(id);
  if (!row || row.status !== "running" || row.backend) return;
  const why: string[] = [];
  for (const b of BACKENDS) {
    const no = await b.unavailable().catch((e) => String(e));
    if (no) {
      why.push(no);
      continue;
    }
    // 问的这一会儿可能已经被叫停了
    if (getJob(id)?.status !== "running") return;
    updateJob(id, { backend: b.name });
    log(`#${id} 交给 ${BACKEND_TEXT[b.name]}${why.length ? `（${why.join("；")}）` : ""}`);
    b.start(asJob(row), hooksFor(id));
    return;
  }
  if (row.stage !== "queued") {
    updateJob(id, { stage: "queued" });
    addJobEvent(id, "queued", `暂时没人能接：${why.join("；")}`);
    log(`#${id} 排队｜${why.join("；")}`);
  }
  if (!state.retry) {
    state.retry = setTimeout(() => {
      state.retry = null;
      void drainQueue();
    }, QUEUE_RETRY_MS);
    state.retry.unref?.();
  }
}

/** 排着队、还没人接的活，按先后顺序再找一遍后端 */
async function drainQueue() {
  for (const j of openJobs()) if (!j.backend) await place(j.id);
}

// ─────────────────────────── 给聊天工具用 ───────────────────────────

/** 派一件活：登记、找后端，马上返回 */
export function dispatch(task: string, dir?: string): string {
  const t = (task || "").trim();
  if (!t) return "要派什么活得说清楚。";
  const cwd = safeDir(dir);
  const request = `${t}\n\n（约束：一、不要修改 ${ROOT} 这个目录里的任何文件。二、删目录、强推、改写 git 历史、对外发布、花钱这类收不回来的动作，做之前先停下来向他提问，他同意了再做。三、需求有两种理解、猜错代价大的时候先问，别硬猜。）`;
  ensureBackHook();
  const id = createJob({ title: `后台执行：${clean(t).slice(0, 26)}`, request, dir: cwd });
  log(`==== #${id} 登记｜目录 ${cwd}｜${clean(t).slice(0, 400)}`);
  void place(id).catch((e) => void finish(id, "failed", `没能交出去：${e instanceof Error ? e.message : e}`));
  // 措辞要诚实：这一步只知道「活登记上了」，还没证明有人接、更没证明干成
  return `登记上了（#${id}），在 ${cwd.replace(HOME, "~")} 里干，后台正在找人接。${
    dir?.trim() ? "" : "（他没给目录，默认在主目录里干；这活要是属于某个项目，下次把 dir 传进来。）"
  }接单、做完、没做成、或者中途要他拿主意，都会单独告诉他。现在只跟他说一句交出去了，别说已经在做、更别说做完了，然后接着聊。`;
}

/** 给她看的后台真实状态（lib/selfstate.ts），也给改自己时判断能不能重启（lib/selfrepair.ts） */
export function listDispatches(): { id: number; title: string; startedAt: number; stage: JobStage; stageText: string; backend: string }[] {
  return openJobs().map((j) => ({
    id: j.id,
    title: clean(j.title).slice(0, 60),
    startedAt: j.started_at,
    stage: j.stage,
    stageText: STAGE_TEXT[j.stage] ?? j.stage,
    backend: j.backend,
  }));
}

function pick(id: string | undefined, rows: JobRow[]): { job?: JobRow; why?: string } {
  const want = Number(String(id ?? "").replace(/[^0-9]/g, ""));
  if (want) {
    const job = rows.find((j) => j.id === want);
    return job ? { job } : { why: `没找到 #${want}，现在有的是：${rows.map((j) => `#${j.id}`).join("、") || "（没有）"}。` };
  }
  if (rows.length === 1) return { job: rows[0] };
  if (!rows.length) return { why: "后台现在没有在跑的活。" };
  return { why: `现在有 ${rows.length} 件，得说是哪件：${rows.map((j) => `#${j.id}（${clean(j.title).slice(0, 20)}）`).join("、")}。` };
}

/** 现在后台有哪些活、各自走到哪一步 */
export function dispatchStatus(): string {
  const jobs = openJobs();
  if (!jobs.length) return "现在没有跑着的外活，都清空了。要看以前做完的，用 task_result。";
  return (
    `有 ${jobs.length} 件没收尾：\n` +
    jobs
      .map((j) => {
        const last = jobEvents(j.id, 1)[0];
        return `#${j.id}｜${clean(j.request).slice(0, 50)}｜${STAGE_TEXT[j.stage] ?? j.stage}（${BACKEND_TEXT[j.backend] ?? j.backend}）｜在 ${j.dir.replace(HOME, "~")}｜${mins(j.started_at)} 分钟了${
          last?.text ? `｜最近：${clean(last.text).slice(0, 80)}` : ""
        }`;
      })
      .join("\n")
  );
}

/** 叫停一件后台活：真停执行那边，不是只改账 */
export async function cancelDispatch(id?: string): Promise<{ ok: boolean; cancelled: string[]; why?: string }> {
  const { job, why } = pick(id, openJobs());
  if (!job) return { ok: false, cancelled: [], why };
  // 还没人接：直接销账
  if (!job.backend) {
    endJob(job.id, "stopped", "他叫停了，还没开始做", "他叫停了，还没开始做");
    log(`#${job.id} 排队中被叫停`);
    return { ok: true, cancelled: [`#${job.id}`] };
  }
  const no = await byName(job.backend)?.cancel(asJob(job));
  if (no) return { ok: false, cancelled: [], why: no };
  // 账先收掉；执行那边随后交回来的话不会再报一遍
  endJob(job.id, "stopped", "他叫停了，没做完", "他叫停了，没做完");
  log(`#${job.id} 被叫停`);
  void drainQueue();
  return { ok: true, cancelled: [`#${job.id}`] };
}

/** 给正在干的活补一句要求，或者回答它的提问 */
export async function appendDispatch(id: string | undefined, text: string): Promise<string> {
  if (!text?.trim()) return "要补什么得说清楚。";
  const { job, why } = pick(id, openJobs());
  if (!job) return `出错了：没补上——${why}`;
  if (!job.backend) return "出错了：这件还在排队没人接，补不进去；先叫停，带上新要求重新派。";
  const no = await byName(job.backend)?.append(asJob(job), text.trim());
  if (no) return `出错了：没补上——${no}。照实告诉他，别说已经转达了。`;
  addJobEvent(job.id, "append", text.trim());
  if (job.stage === "asking") updateJob(job.id, { stage: "working" });
  return `补上了（#${job.id}），那边下一步就能看到。`;
}

/** 一件活的完整记录：原话、走到哪、中途的事、完整结果。他事后追问时用 */
export function jobReport(id?: string): string {
  const rows = recentJobs(8);
  if (!rows.length) return "还没有派出去过的活。";
  const want = Number(String(id ?? "").replace(/[^0-9]/g, ""));
  const job = want ? getJob(want) : rows.length === 1 ? rows[0] : undefined;
  if (!job)
    return (
      `${want ? `没找到 #${want}。` : ""}最近的几件（要看哪件就带上编号再调一次）：\n` +
      rows.map((j) => `#${j.id}｜${clean(j.request).slice(0, 50)}｜${STAGE_TEXT[j.stage] ?? j.stage}｜${mins(j.ended_at ?? j.started_at)} 分钟前`).join("\n")
    );
  const events = jobEvents(job.id)
    .filter((e) => e.text)
    .map((e) => `- ${new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false })} ${e.type}：${clean(e.text).slice(0, 300)}`)
    .join("\n");
  return [
    `#${job.id}｜${STAGE_TEXT[job.stage] ?? job.stage}｜${BACKEND_TEXT[job.backend] ?? job.backend}｜在 ${job.dir.replace(HOME, "~")}`,
    `他要的：${job.request.slice(0, 1500)}`,
    events ? `中途：\n${events}` : "",
    job.detail ? `完整结果：\n${job.detail.slice(0, 8000)}` : "还没有结果。",
    "（回复里别念编号和目录；文件在哪他点之前那张卡片就能看到。）",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 服务启动时把没收尾的活接回来：superagent 那边的照常在跑，接着盯；
 * 内置执行器的跟着进程一起没了，记成没做完并照实告诉他；还没人接的重新找后端。
 */
export function recoverJobs() {
  ensureBackHook();
  const lost: JobRow[] = [];
  for (const j of openJobs()) {
    if (!j.backend) continue;
    const ok = byName(j.backend)?.resume(asJob(j), hooksFor(j.id)) ?? false;
    if (ok) {
      log(`#${j.id} 重启后接回来了（${BACKEND_TEXT[j.backend] ?? j.backend}）`);
      continue;
    }
    if (endJob(j.id, "failed", "服务中途重启，这件没跑完", "服务中途重启，这件没跑完")) lost.push(j);
    log(`#${j.id} 重启时被打断，没跑完`);
  }
  if (lost.length) {
    const names = lost.map((j) => `「${clean(j.request).slice(0, 40)}」`).join("、");
    void tell(
      `服务刚才重启过，你后台的这${lost.length > 1 ? "几" : ""}件活被打断了、没做完：${names}。照实告诉他，问他要不要重新来。`,
      `刚才重启了一下，后台这${lost.length > 1 ? "几" : ""}件被打断了、没做完：${names}。要重新来吗？`,
    );
  }
  void drainQueue();
}
