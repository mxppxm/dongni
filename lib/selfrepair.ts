import "server-only";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, getKv, setKv } from "./db";
import { speakAsHer } from "./speak";
import { onCall, whenOffCall } from "./presence";
import { dshActivity, dshBackend } from "./backend/dsh";
import type { Job } from "./backend/types";
import { listDispatches } from "./superagent";
import { finishTask, startTask } from "./tasks";

/**
 * 自我修复：把用户的要求交给 DSH superagent 的执行器去改本项目的代码（以前是外挂的 pi，已经拿掉）。
 *
 * 几件改动可以同时进行：每件在自己的一份代码副本（git worktree）里改，互不干扰；
 * 改完在副本里过类型检查、提交，再一件一件并回正在运行的这份代码；这一批都并完了只重启一次，体检不过整批退回。
 * 以前所有改动都直接在运行中的这份代码里改，只能排队一件一件来，每件各重启一次。
 *
 * 规矩：
 * - 运行中的这份代码里有别人没提交的改动：并回来之前先原样提交成一笔留底，不吞进她的提交。
 * - 副本里的改动碰了内核文件、动了版本历史，这一件作废；副本删掉就是退回，运行中的代码没被碰过。
 * - 同一件事连着两次没改成就不再改，改不动的（外部接口没授权、网络不通）也不该反复交出去。
 */
const run = promisify(execFile);
const ROOT = process.cwd();
const LOG = path.join(ROOT, "logs", "self-repair.log");
const RESULT = path.join(ROOT, "data", "rebuild-result.json");
/** 改动用的代码副本放这儿：不能放在项目目录里，不然类型检查和编译会把副本里的文件也扫进去 */
const WORKTREES = path.join(os.homedir(), ".cache", "dongni", "worktrees");
/** 同时最多改几件：superagent 一共三个执行器，留一个给派出去的活 */
const MAX_PARALLEL = Number(process.env.DONGNI_REPAIR_PARALLEL ?? 2);

/**
 * 内核：它改不了的部分。自我修复机制本身、重启脚本、健康检查、启动入口、数据库与备份、忽略规则。
 * 改完只要碰到这些文件，整次作废退回——由程序检查，不靠提示词。
 */
const PROTECTED = [
  "lib/selfrepair.ts",
  "lib/db.ts",
  "scripts/rebuild.sh",
  "app/api/health/route.ts",
  "instrumentation.ts",
  ".gitignore",
  "package.json",
  "pnpm-lock.yaml",
];
const PROTECTED_DIRS = ["data/", "logs/", ".git/"];

/** 正在改的一件：要求、任务栏那一行、它的代码副本、替她改代码的那件 superagent 活 */
type Repair = { taskId: number; request: string; wt: string; branch: string; at: number; coder: Job | null; stopped?: boolean; abort?: () => void };
/** 这一批已经并回来、等重启生效的改动：good 是这一批开始之前的版本（体检不过退回这里） */
type Batch = { good: string; fix: string; items: { taskId: number; request: string; summary: string }[] };
type State = { repairs: Map<number, Repair>; merging: Promise<unknown>; batch: Batch | null; restarting: boolean };

const state = ((globalThis as unknown as { __dongniRepairs?: State }).__dongniRepairs ??= {
  repairs: new Map<number, Repair>(),
  merging: Promise.resolve(),
  batch: null,
  restarting: false,
});

function log(line: string) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${line}\n`);
}

/** 往对话里补一条她说的话（kind=system 表示系统通知，不算她说的） */
export function postAssistant(content: string, kind: "chat" | "system" = "chat") {
  db()
    .prepare("INSERT INTO messages(role, content, status, extracted, created_at, kind) VALUES('assistant', ?, 'done', 1, ?, ?)")
    .run(content, Date.now(), kind);
}

/** 让她用自己的话说出来（接着刚才的话头），说不出来就用简短的原意 */
async function say(what: string, fallback: string, opts?: { fresh?: boolean }) {
  postAssistant(await speakAsHer(what, fallback, opts));
}

const gitIn = (cwd: string, ...args: string[]) => run("git", args, { cwd, maxBuffer: 20 << 20 });
const git = (...args: string[]) => gitIn(ROOT, ...args);
const headOf = async (cwd: string) => (await gitIn(cwd, "rev-parse", "HEAD")).stdout.trim();

/** 这份代码里相对 good 动过的文件里，有没有内核文件 */
async function touchedProtected(cwd: string, good: string) {
  const tracked = (await gitIn(cwd, "diff", "--name-only", good)).stdout.split("\n").filter(Boolean);
  const untracked = (await gitIn(cwd, "ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean);
  return [...tracked, ...untracked].filter((f) => PROTECTED.includes(f) || PROTECTED_DIRS.some((d) => f.startsWith(d)));
}

/** 改完后的硬检查：不许自己提交/改历史，不许碰内核 */
async function guard(cwd: string, good: string) {
  if ((await headOf(cwd)) !== good) throw new Error("改动里动了版本历史，不允许");
  const bad = await touchedProtected(cwd, good);
  if (bad.length) throw new Error(`改动碰到了不允许改的内核文件：${bad.join("、")}`);
}

function coderPrompt(request: string, dir: string) {
  return `你在修改「懂你」这个聊天应用的代码。要改的代码就在当前工作目录：${dir}
这是专门给这次改动准备的一份代码副本，正在运行的那份在 ${ROOT}（只许看，不许改）。运行日志在 ${ROOT}/logs/dongni.log 和 ${ROOT}/logs/self-repair.log，要查问题可以读。
先读 README.md 了解结构。

他的要求：
${request}

怎么干：
- 只在当前工作目录里改文件。不要建分支、不要建 worktree、不要 git commit、不要开 PR、不要 git stash / reset / checkout——提交、合并、编译、重启外面会自动做，你动了版本历史这次改动会被整个作废。
- 不要动 ${ROOT} 里的任何东西，不要动 data/、logs/、.next/、node_modules/，不要删用户数据。
- 以下「内核」文件不许改，改了整次会被作废退回：${PROTECTED.join("、")}。需要新的存储就在别的模块里用 db() 建新表（CREATE TABLE IF NOT EXISTS），或用 kv 表。
- 改完会自动重启并做健康检查（打开首页、/api/health），检查不过会自动退回。所以首页和 lib/chat.ts 里的 selfTest() 必须保持能用。
- 可能同时有别的改动在各自的副本里进行，最后会依次合并。所以只改这件事需要动的地方，别顺手重排、重命名、格式化无关的代码——那样合并时会撞。
- 不许给她加任何限制：回复字数上限、发消息的次数/间隔/时段、沉默规则、按关键词裁工具、截短她记得的对话……他明确说过不要。要解决「啰嗦」「打扰」这类问题，改她的说话方式和判断，不要加硬卡。
- 怎么最快：直接读相关文件、改、跑 pnpm typecheck，就够了。不要另搭测试脚手架、不要写脚本去真的设定时器或调接口；不要开浏览器、截图或做界面验证；不要另起一个服务实例；搜文件只在当前工作目录里搜。
- 保持原有设计原则：输入方便、动效好看、页面干净、非必要的东西不出现、响应快、不丢东西。不要顺手加没被要求的文案或功能。
- 不要运行 pnpm build、不要 pnpm install、不要重启服务。
- 改完必须运行 pnpm typecheck，确保通过。
- 能自己判断的自己判断；只有需求有两种理解、猜错代价大的时候才提问。
- 最后用中文、大白话、三五句话说清你改了什么（不要贴代码）。如果判断不该改或改不了，说明原因。`;
}

/** 一次改动最多给这么久；再不交卷就叫停（它那边的活是真的停，不是只在这边放手） */
const CODER_LIMIT_MS = Number(process.env.DONGNI_CODER_LIMIT_MS ?? 40 * 60_000);

/** 等 superagent 能接活：没在线会顺手拉它（见 lib/backend/dsh.ts），最多等两分钟 */
async function coderReady() {
  let why = await dshBackend.unavailable();
  for (let i = 0; why && i < 12; i++) {
    await new Promise((ok) => setTimeout(ok, 10_000));
    why = await dshBackend.unavailable();
  }
  if (why) throw new Error(`superagent 现在接不了活：${why}`);
}

/**
 * 让 superagent 来改：投一件活过去（工作目录是这件改动自己的代码副本），等它交卷，返回它说的改了什么。
 * 它没做成、被叫停、超时，都抛错——外面按「没改成」收场。
 */
async function runCoder(r: Repair, request: string): Promise<string> {
  await coderReady();
  const t0 = Date.now();
  const tag = `#${r.taskId}`;
  return new Promise<string>((resolve, reject) => {
    const job: Job = { id: r.taskId, request: coderPrompt(request, r.wt), dir: r.wt, extId: "" };
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      r.coder = null;
      saveInflight();
      fn();
    };
    const limit = setTimeout(() => {
      void dshBackend.cancel(job).catch(() => {});
      settle(() => reject(new Error(`超过 ${Math.round(CODER_LIMIT_MS / 60_000)} 分钟没改完，已经叫停`)));
    }, CODER_LIMIT_MS);
    r.coder = job;
    // 他叫停：这边马上放手（那边的活由 cancelRepair 去停）
    r.abort = () => settle(() => reject(new Error("他叫停了")));
    dshBackend.start(job, {
      ext: (extId) => {
        job.extId = extId;
        saveInflight();
      },
      event: (type, text) => {
        if (type === "stage") return;
        log(`${tag} superagent ${type}｜${text.replace(/\s+/g, " ").slice(0, 300)}`);
        const what = r.request.replace(/\s+/g, " ").slice(0, 30);
        // 它没新开工单、并到了以前的工单上：那张工单的执行器在旧目录里干活，改动不会落在这次的副本里——停掉，按没改成算
        if (type === "adopted") {
          void dshBackend.cancel(job).catch(() => {});
          settle(() => reject(new Error("superagent 把这件并到了以前的工单上，没在这次的代码副本里改")));
          return;
        }
        if (type === "stall")
          void say(
            `你在改自己的代码（${what}），但后台那边${text}，可能卡住了。照实告诉他，问他是再等等还是停掉重来。`,
            `改代码那边（${what}）${text}，可能卡住了。要再等等，还是停掉重来？`,
            { fresh: true },
          );
        // 它停下来问他：把问题转给他；他的回答由 task_append 送回来（见 repairAppend）
        if (type === "ask")
          void say(
            `你在改自己的代码（${what}），改到一半需要他拿个主意。问题原文是：\n${text.slice(0, 800)}\n把这个问题用你的话问他，别替他答。他回答之后用 task_append 把回答转过去。`,
            `改到一半要你拿个主意：\n\n${text.slice(0, 800)}`,
            { fresh: true },
          );
      },
      finish: (stage, text) => {
        log(`${tag} superagent 交卷（${stage}）｜用时 ${Math.round((Date.now() - t0) / 1000)} 秒\n--- 结果 ---\n${text}`);
        settle(() => (stage === "done" ? resolve(text.trim()) : reject(new Error(`superagent 没改成（${stage}）：${text.slice(0, 400)}`))));
      },
    });
  });
}

/**
 * 叫停一件正在改自己的活：superagent 那边真停，这件的代码副本删掉，运行中的代码没被碰过。
 * 没有在改的返回 null；已经并进来等重启的那些停不了（它们已经是代码的一部分了）。
 */
export async function cancelRepair(id?: string): Promise<{ ok: boolean; text: string } | null> {
  const live = [...state.repairs.values()].filter((r) => !r.stopped);
  if (!live.length) return null;
  const want = Number(String(id ?? "").replace(/[^0-9]/g, ""));
  const picked = want ? live.filter((x) => x.taskId === want) : live;
  if (want && !picked.length) return null;
  for (const r of picked) {
    r.stopped = true;
    log(`#${r.taskId} 他叫停了`);
    if (r.coder) await dshBackend.cancel(r.coder).catch(() => {});
    r.abort?.();
  }
  // 排着队还没开始的也一并撤掉：他说停，就别等这几件停完又冒出新的
  if (!want) setKv("repair_queue", "[]");
  return { ok: true, text: `改自己的那${picked.length > 1 ? `${picked.length} 件` : "件"}停掉了（${picked.map((r) => `#${r.taskId}`).join("、")}），还没并进来的改动都丢掉了，运行中的代码没动。${want ? "" : "排着队的也撤了。"}` };
}

/** 他中途补的话、对它提问的回答：送给正在改代码的那件活。现在没有在改就返回 null；同时改着好几件要说是哪件 */
export async function repairAppend(text: string, id?: string): Promise<string | null> {
  const live = [...state.repairs.values()].filter((r) => r.coder);
  if (!live.length) return null;
  const want = Number(String(id ?? "").replace(/[^0-9]/g, ""));
  const r = want ? live.find((x) => x.taskId === want) : live.length === 1 ? live[0] : undefined;
  if (!r) return `出错了：没补上——现在同时在改 ${live.length} 件，得说是哪件：${live.map((x) => `#${x.taskId}（${x.request.replace(/\s+/g, " ").slice(0, 20)}）`).join("、")}。`;
  const no = await dshBackend.append(r.coder!, text);
  if (no) return `出错了：没补上——${no}`;
  log(`#${r.taskId} 他补了一句｜${text.replace(/\s+/g, " ").slice(0, 200)}`);
  return "补上了，改代码的那边下一步就能看到。";
}

/**
 * 子进程的 locale 由我们补：服务的父进程是 launchd，环境里没有 LANG，
 * 编译脚本、三方 CLI 拿到中文会按 ASCII 处理。
 */
const utf8Env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  LANG: process.env.LANG || "en_US.UTF-8",
  LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
});

export function repairRunning() {
  const first = [...state.repairs.values()][0];
  return first ? first.request.slice(0, 40) : null;
}

/** 后台改代码的真实状态（给她看，免得她说「在修」其实啥也没在跑） */
export function repairStatus() {
  const q = queue();
  const lastAt = Number(getKv("repair_last_at") ?? 0);
  const ago = (t: number) => `${Math.max(1, Math.round((Date.now() - t) / 60000))} 分钟前`;
  const running = [...state.repairs.values()].map((r) => {
    const a = r.coder ? dshActivity(r.taskId) : null;
    const idle = a ? Math.round((Date.now() - a.lastAt) / 1000) : 0;
    const live = a ? `；真实动静：${a.steps ? `第 ${a.steps} 步，` : ""}${idle < 60 ? `${idle} 秒前还在动` : `${Math.floor(idle / 60)} 分钟没动静了`}${a.doing ? `，${a.doing}` : ""}` : "";
    return `#${r.taskId}「${r.request.replace(/\s+/g, " ").slice(0, 30)}…」（${ago(r.at)}开始的${live}）`;
  });
  const lines = [
    running.length
      ? `正在改你自己的代码，${running.length} 件同时在改、互不排队：${running.join("；")}。`
      : "现在后台没有在改你自己的代码。",
    `改你自己是这样的：几件可以同时改（最多 ${MAX_PARALLEL} 件，再多的排队），每件改完先并进来，这一批都改完了一起重启一次才生效。他问为什么还没生效、要不要等，照这个说。`,
  ];
  if (state.batch) lines.push(`已经改完并进来、等重启生效的有 ${state.batch.items.length} 件${running.length ? "（等还在改的那几件完事一起重启）" : "（马上重启）"}。`);
  if (q.length) lines.push(`排队等着改的还有 ${q.length} 件：${q.map((x) => `「${x.slice(0, 24)}…」`).join("、")}`);
  if (lastAt) lines.push(`上一次改完是 ${ago(lastAt)}：${getKv("repair_last_result") ?? ""}`);
  return lines.join("\n");
}

/** 超过同时改的上限的要求先存起来（存库里，重启也不丢），有空位了接着改 */
function queue(): string[] {
  try {
    return JSON.parse(getKv("repair_queue") || "[]");
  } catch {
    return [];
  }
}

/** 改过的记录：同一件事改不成就别一遍遍再交出去 */
type Attempt = { req: string; at: number; ok: boolean };
const HISTORY_KEY = "repair_history";
const HISTORY_DAYS = 3;

function attempts(): Attempt[] {
  try {
    const all = JSON.parse(getKv(HISTORY_KEY) || "[]") as Attempt[];
    return all.filter((a) => Date.now() - a.at < HISTORY_DAYS * 86400_000);
  } catch {
    return [];
  }
}

function noteAttempt(req: string, ok: boolean) {
  setKv(HISTORY_KEY, JSON.stringify([...attempts(), { req: req.slice(0, 300), at: Date.now(), ok }].slice(-60)));
}

/** 去掉套话后的字二元组；措辞每次不一样，但讲的是同一件事时重合度很高 */
function grams(t: string) {
  const s = t.replace(/（这是你自己回看后决定的改进）|[\s\p{P}\p{S}]/gu, "");
  const g = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}

function similar(a: string, b: string) {
  const x = grams(a);
  const y = grams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const k of x) if (y.has(k)) both++;
  return both / Math.min(x.size, y.size);
}

/** 这件事最近是不是已经改不成好几次了，或者刚刚改好过 */
function repeatOf(request: string): string | null {
  const near = attempts().filter((a) => similar(a.req, request) >= 0.6);
  const failed = near.filter((a) => !a.ok).length;
  if (failed >= 2) return `同一件事这三天已经改了 ${failed} 次都没改成`;
  if (near.some((a) => a.ok && Date.now() - a.at < 86400_000)) return "同一件事今天刚改好过";
  return null;
}

/**
 * 日志里这类错是外面的事（接口没授权、额度、限流、域名解析不了），改代码改不好，不拿去当改自己的由头。
 * 超时不在里面：执行器 60 秒就判死那种超时是代码的问题，得能改。
 */
export const EXTERNAL_FAULT =
  /\b(401|403|429)\b|not granted|unauthori[sz]ed|forbidden|quota|额度|欠费|余额不足|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i;

/** 运行中的这份代码里有别人没提交的改动：原样提交成一笔留底，不吞进她的提交，也不让合并撞上 */
function snapshotDirty() {
  try {
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    if (!dirty.length) return;
    execFileSync("git", ["add", "-A"], { cwd: ROOT });
    execFileSync("git", ["commit", "-q", "-m", `自我修复前留底：${dirty.length} 个文件有没提交的改动`], { cwd: ROOT });
    log(`运行中的代码里有没提交的改动，先提交留底：${dirty.slice(0, 8).join(" ")}`);
  } catch (e) {
    log(`留底提交没成（${e instanceof Error ? e.message : e}），照样往下走`);
  }
}

/** 正在改的那几件记在库里：改到一半服务被重启了，回来能把它们那边的活停掉、把副本收拾干净 */
const INFLIGHT_KEY = "repair_inflight";
type Inflight = { taskId: number; request: string; wt: string; branch: string; extId: string };
function saveInflight() {
  setKv(
    INFLIGHT_KEY,
    JSON.stringify([...state.repairs.values()].map((r) => ({ taskId: r.taskId, request: r.request, wt: r.wt, branch: r.branch, extId: r.coder?.extId ?? "" }) satisfies Inflight)),
  );
}

/** 这一批并进来、等重启体检出结果的改动 */
const BATCH_KEY = "repair_batch";

/** 她自己回看后决定的改进：标着这个的一律不改（他 2026-11-03 定的：只改他让改的） */
const SELF_INITIATED = "（这是你自己回看后决定的改进）";

export function drainRepairQueue() {
  while (state.repairs.size < MAX_PARALLEL && !state.restarting) {
    const q = queue().filter((r) => !r.includes(SELF_INITIATED));
    const next = q.shift();
    setKv("repair_queue", JSON.stringify(q));
    if (!next) return;
    startRepair(next);
  }
}

export function startRepair(request: string): string {
  if (request.includes(SELF_INITIATED)) {
    log(`不改：这是她自己决定的改进，他没让改：${request.slice(0, 80)}`);
    return "改自己只改他让你改的；这是你自己想改的，没有交出去。别说在改；想法可以照实跟他说，由他决定要不要改。";
  }
  if (getKv("repair_paused") === "1")
    return "改自己的功能现在被对方暂停了（对方让别人来改）。这次没有交出去，别说你在改；如实告诉对方，你把想法记下了。";
  const again = repeatOf(request);
  if (again) {
    log(`不再交出去（${again}）：${request}`);
    return `这件没有交出去：${again}，再改也是白改。别说你在改；如实告诉对方，这事可能要他来看（比如外面的接口、账号、网络的问题）。`;
  }
  if ([...state.repairs.values()].some((r) => similar(r.request, request) >= 0.6)) return "同样的事已经在改了，这次没有重复交。如实告诉对方那件正在改。";
  // 正在重启、或者同时改的已经到上限：先排着，有空位（或者重启回来）就接着改
  if (state.restarting || state.repairs.size >= MAX_PARALLEL) {
    if (queue().some((q) => similar(q, request) >= 0.6)) return "同样的事已经在排队了，这次没有重复交。如实告诉对方前面排着呢。";
    setKv("repair_queue", JSON.stringify([...queue(), request]));
    return state.restarting
      ? "这会儿正在重启，这件已经排上了，重启回来（半分钟）就开始改。如实告诉对方。"
      : `现在已经有 ${state.repairs.size} 件同时在改（最多同时 ${MAX_PARALLEL} 件），这件排上了，有一件改完就接着改它。如实告诉对方要排一会儿。`;
  }
  const taskId = startTask("repair", `改自己：${request.replace(/\s+/g, " ").slice(0, 30)}`);
  const r: Repair = { taskId, request, wt: path.join(WORKTREES, `r${taskId}`), branch: `repair/r${taskId}`, at: Date.now(), coder: null };
  const others = state.repairs.size;
  state.repairs.set(taskId, r);
  saveInflight();
  setKv("repair_started_at", String(Date.now()));
  void pipeline(r);
  return `已经交到后台开始改了${others ? `（另外还有 ${others} 件也在同时改，各改各的，互不排队）` : ""}。改代码要几分钟，改好会在对话里告诉对方；这一批都改完了会一起重启一次才生效。`;
}

/** 给这件改动准备一份自己的代码副本：从当前版本拉出来，依赖用运行中那份的 */
async function prepareWorktree(r: Repair): Promise<string> {
  fs.mkdirSync(WORKTREES, { recursive: true });
  await removeWorktree(r);
  // 副本里挂的依赖、类型声明不是代码，别被提交进去（这个排除文件所有副本共用，对运行中那份没有影响）
  try {
    const exclude = path.resolve(ROOT, (await git("rev-parse", "--git-path", "info/exclude")).stdout.trim());
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    const need = ["node_modules", "next-env.d.ts"].filter((x) => !cur.split("\n").includes(x));
    if (need.length) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${cur.endsWith("\n") || !cur ? "" : "\n"}${need.join("\n")}\n`);
    }
  } catch {}
  const base = await headOf(ROOT);
  await git("worktree", "add", "-q", "-b", r.branch, r.wt, base);
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(r.wt, "node_modules"));
  try {
    fs.copyFileSync(path.join(ROOT, "next-env.d.ts"), path.join(r.wt, "next-env.d.ts"));
  } catch {}
  return base;
}

async function removeWorktree(r: { wt: string; branch: string }) {
  await git("worktree", "remove", "--force", r.wt).catch(() => {});
  fs.rmSync(r.wt, { recursive: true, force: true });
  await git("worktree", "prune").catch(() => {});
  await git("branch", "-D", r.branch).catch(() => {});
}

const typecheck = (cwd: string) => run("pnpm", ["typecheck"], { cwd, maxBuffer: 20 << 20, env: utf8Env() });

/** 一件改动从头到尾：备副本 → 它来改 → 检查 → 在副本里提交 → 并回运行中的代码 → 这一批都完了就重启 */
async function pipeline(r: Repair, attempt = 1): Promise<void> {
  const tag = `#${r.taskId}`;
  let merged = false;
  let ok = false;
  let handed = false; // 撞了、交给「重来一次」的那一轮接手：这一轮不收尾
  let note = "没改成，运行中的代码没动";
  try {
    log(`==== ${tag} 开始${attempt > 1 ? "（和别的改动撞了，在最新代码上重来）" : ""}：${r.request}`);
    const base = await prepareWorktree(r);
    if (r.stopped) throw new Error("他叫停了");
    let summary = await runCoder(r, r.request);
    if (r.stopped) throw new Error("他叫停了");
    await guard(r.wt, base);
    if (!(await gitIn(r.wt, "status", "--porcelain")).stdout.trim()) {
      await say(`你看了一圈，这次没有改代码。后台的说明：${summary}`, "看了一圈，这次没动代码。");
      ok = true;
      note = "看过了，没动代码";
      noteAttempt(r.request, false); // 没动代码也不算解决了：同一件事别再一遍遍交出去
      return;
    }
    try {
      await typecheck(r.wt);
    } catch (e) {
      // 类型检查没过：让它在同一份副本上再修一次
      const msg = (e as { stdout?: string }).stdout?.slice(-3000) ?? String(e);
      log(`${tag} typecheck 失败，再修一次：\n${msg}`);
      summary = await runCoder(r, `${r.request}\n\n（上一轮已经改过，代码就在目录里，但 pnpm typecheck 没通过，报错如下。接着现在的代码修好，别从头再来）\n${msg}`);
      await guard(r.wt, base);
      await typecheck(r.wt);
    }
    await gitIn(r.wt, "add", "-A");
    await gitIn(r.wt, "commit", "-q", "-m", `自我修复：${r.request.slice(0, 60)}`);
    const sha = await headOf(r.wt);

    // 并回运行中的代码：一件一件来，别两件同时往里并
    const conflict = await inMergeLane(async () => {
      snapshotDirty();
      const before = await headOf(ROOT);
      try {
        await git("cherry-pick", sha);
      } catch {
        await git("cherry-pick", "--abort").catch(() => {});
        return true;
      }
      try {
        await typecheck(ROOT);
      } catch (e) {
        await git("reset", "-q", "--hard", before);
        throw new Error(`并进来之后类型检查没过，已经撤掉这一件：${((e as { stdout?: string }).stdout ?? String(e)).slice(-400)}`);
      }
      const fix = await headOf(ROOT);
      state.batch = { good: state.batch?.good ?? before, fix, items: [...(state.batch?.items ?? []), { taskId: r.taskId, request: r.request, summary }] };
      setKv(BATCH_KEY, JSON.stringify(state.batch));
      return false;
    });
    if (conflict) {
      // 另一件先并进去了、改了同一块：在最新代码上重来一次；再撞就算了
      if (attempt >= 2) throw new Error("和同时在改的另一件改到了同一处，重来一次还是并不进来");
      log(`${tag} 和别的改动撞了，在最新代码上重来`);
      await removeWorktree(r);
      handed = true;
      return await pipeline(r, attempt + 1);
    }
    merged = true;
    ok = true;
    log(`${tag} 并进来了`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`${tag} ${r.stopped ? "被叫停" : "失败"}：${msg}`);
    // 他叫停的不算「改不成」，也不用再说一遍——叫停的那句回复里已经说了
    if (r.stopped) note = "他叫停了";
    else noteAttempt(r.request, false);
    if (!r.stopped)
      await say(`这次改自己（${r.request.replace(/\s+/g, " ").slice(0, 40)}）没改成，运行中的代码没被动过，什么都没坏。原因（技术细节别说）：${msg.slice(0, 200)}`, "这次没改成，啥也没坏。").catch(() => {});
  } finally {
    if (!handed) {
      await removeWorktree(r).catch(() => {});
      state.repairs.delete(r.taskId);
      saveInflight();
      setKv("repair_last_at", String(Date.now()));
      // 并进来的那几件等重启体检回来再收尾（reportRebuild）；没并进来的现在就收
      if (!merged) {
        setKv("repair_last_result", `${ok ? "看过了，没动代码" : "没改成"}（${r.request.slice(0, 30)}…）`);
        finishTask(r.taskId, ok, note);
      }
      setTimeout(() => {
        drainRepairQueue();
        void maybeRestart();
      }, 500);
    }
  }
}

function inMergeLane<T>(job: () => Promise<T>): Promise<T> {
  const p = state.merging.then(job, job);
  state.merging = p.catch(() => {});
  return p;
}

/** 这一批都改完了（没有还在改的、也没有排着队的）：重启一次让它们生效。还有在改的就等它们 */
async function maybeRestart() {
  const batch = state.batch;
  if (!batch || state.restarting || state.repairs.size || queue().length) {
    if (batch && !state.restarting && state.repairs.size) log(`${batch.items.length} 件已经并进来，等还在改的 ${state.repairs.size} 件完事一起重启`);
    return;
  }
  state.restarting = true;
  try {
    const what = batch.items.map((x) => `「${x.request.replace(/\s+/g, " ").slice(0, 30)}」：${x.summary.slice(0, 300)}`).join("\n");
    const n = batch.items.length;
    setKv("repair_summary", what);
    setKv("repair_last_result", `${n} 件改完并进来了，正在重启体检，结果还没出来`);
    log(`${n} 件都并进来了，后台重新编译并重启`);
    // 正在打电话就先别重启（重启会把电话挂断），挂了再重启；但不能一直等——挂了电话这件事本身也可能正是这次改的内容
    await waitIdle();
    if (onCall()) {
      await say(
        `你刚把自己改好了（${n} 件），但你正在打电话，我不挂你电话：等你挂了我就重启，半分钟回来。改了什么（后台的说明，挑他关心的说一句就够）：\n${what}`,
        "改好啦，你还在打电话，我不挂你，等你挂了我再重启～",
      );
      log("在通话，等挂断再重启（最多等 12 分钟）");
      await Promise.race([whenOffCall(), new Promise((done) => setTimeout(done, 12 * 60_000))]);
      if (onCall()) log("等了 12 分钟还没挂断，先重启（这通电话会被打断）");
    } else {
      await say(
        `你刚把自己改好了（${n} 件${n > 1 ? "，是同时改的" : ""}），马上要重启，半分钟左右回来。改了什么（后台的说明，挑他关心的说一句就够）：\n${what}`,
        "改好啦，我重启一下，半分钟就回来～",
      );
    }
    // 新起一个进程组去编译重启，自己被重启也不影响它
    const child = spawn("/bin/bash", [path.join(ROOT, "scripts", "rebuild.sh"), batch.good, batch.fix], {
      cwd: ROOT,
      env: utf8Env(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // 重启脚本万一没把进程换掉：别让「正在重启」一直挂着，后面的改动全排着进不来
    setTimeout(() => {
      state.restarting = false;
      state.batch = null;
      log("等了 6 分钟进程还没被换掉，重启可能没成，放开后面的改动");
      drainRepairQueue();
    }, 6 * 60_000).unref?.();
  } catch (e) {
    state.restarting = false;
    log(`重启没发起来：${e instanceof Error ? e.message : e}`);
  }
}

/**
 * 重启前等手上的事做完：电话（单独处理）、内置执行器在干的活、正在生成的回复。
 * superagent 那边的活不受重启影响，不用等。最多等 15 分钟。
 */
async function waitIdle() {
  const busy = () => {
    const why: string[] = [];
    if (listDispatches().some((d) => d.backend === "builtin")) why.push("派出去的活");
    const cur = (globalThis as unknown as { __dongniRunning?: { cur: unknown } }).__dongniRunning?.cur;
    if (cur) why.push("正在说的回复");
    return why;
  };
  const until = Date.now() + 15 * 60_000;
  let told = false;
  for (let why = busy(); why.length && Date.now() < until; why = busy()) {
    if (!told) log(`等${why.join("、")}结束再重启（最多 15 分钟）`);
    told = true;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
}

/**
 * 启动时收拾：上一次有改到一半的（服务被重启了），把 superagent 那边的活停掉、副本删掉、任务栏收尾。
 * 改动都在副本里，运行中的代码没被碰过，所以没有什么要退回的。
 */
export function recoverInterruptedRepair() {
  let list: Inflight[] = [];
  try {
    const raw = JSON.parse(getKv(INFLIGHT_KEY) || "[]") as Inflight[] | Inflight | null;
    list = Array.isArray(raw) ? raw : [];
  } catch {}
  // 有改动已经并进了代码、但还没来得及重启体检，服务就被别的原因重启了：把这一批接回来，过一会儿补上那次重启
  if (!state.batch && !fs.existsSync(RESULT)) {
    try {
      const b = JSON.parse(getKv(BATCH_KEY) || "null") as Batch | null;
      if (b?.items?.length) {
        state.batch = b;
        log(`上次有 ${b.items.length} 件并进来了还没重启体检，接回来补上`);
        // 等久一点：如果这次启动本身就是重启体检那一次，体检结果几秒后就到（reportRebuild 会把这一批清掉）
        setTimeout(() => void maybeRestart(), 3 * 60_000).unref?.();
      }
    } catch {}
  }
  if (!list.length || state.repairs.size) return;
  setKv(INFLIGHT_KEY, "[]");
  for (const r of list) {
    if (!r?.taskId) continue;
    log(`#${r.taskId} 上次改到一半服务被重启了，收拾掉：${r.request}`);
    if (r.extId) {
      const job: Job = { id: r.taskId, request: "", dir: r.wt, extId: r.extId };
      dshBackend.resume(job, { ext: () => {}, event: () => {}, finish: () => {} });
      void dshBackend.cancel(job).then((no) => log(no ? `#${r.taskId} 那件改代码的活没停成：${no}` : `#${r.taskId} 那件改代码的活已经停掉`));
    }
    if (r.wt && r.branch) void removeWorktree(r);
    noteAttempt(r.request, false);
    finishTask(r.taskId, false, "改到一半服务重启了，没改成");
    setKv("repair_last_at", String(Date.now()));
    setKv("repair_last_result", `没改成：改到一半被重启打断（${r.request.slice(0, 30)}…）`);
  }
}

/** 启动时：如果是自我修复后的重启，把结果告诉用户 */
export function reportRebuild() {
  recoverInterruptedRepair();
  if (!fs.existsSync(RESULT)) return;
  try {
    const r = JSON.parse(fs.readFileSync(RESULT, "utf8")) as { ok: boolean; reason?: string };
    let batch: Batch | null = null;
    try {
      batch = JSON.parse(getKv(BATCH_KEY) || "null") as Batch | null;
    } catch {}
    const what = r.ok
      ? ["你重启回来了，刚才改的已经生效，可以让他试试。", "我回来啦，改好的已经能用了，你试试～"]
      : ["你重启回来了，但新改的没通过，已经退回改之前的样子，一切照旧。", "我回来了，不过新改的没成，已经退回原样了。"];
    // 这是状态播报，不能被「跟刚才那句太像」的闸门吞掉
    void say(what[0], what[1], { fresh: true });
    for (const item of batch?.items ?? []) {
      finishTask(item.taskId, r.ok, r.ok ? "改好了，已生效" : "新改的没通过，已退回");
      noteAttempt(item.request, r.ok);
    }
    setKv(BATCH_KEY, "");
    state.batch = null;
    setKv("repair_last_result", r.ok ? "改好了，已经生效" : "新改的没通过体检，已经退回原样");
    log(`重启完成 ok=${r.ok}`);
  } finally {
    fs.rmSync(RESULT, { force: true });
    if (getKv("repair_summary")) setKv("repair_summary", "");
  }
}
