import "server-only";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { piModelArgs } from "./llmconfig";
import { db, getKv, setKv } from "./db";
import { speakAsHer } from "./speak";
import { onCall, whenOffCall } from "./presence";
import { stallWatchdog } from "./stall";
import { listDispatches } from "./superagent";
import { finishTask, startTask } from "./tasks";

/**
 * 自我修复：把用户的要求交给 pi（编码 agent）去改本项目的代码，
 * 改完做类型检查 → 提交 → 后台重新编译并重启。任何一步失败都退回修改前的版本。
 *
 * 跟别人共用一个代码目录，所以：
 * - 工作区里有别人没提交的改动：先原样提交成一笔留底再开工，不把别人的东西吞进自己的提交，也不排队干等。
 * - 退回用 git stash 留底，不用 reset --hard / clean，谁的改动都不会被删掉。
 * - 同一件事连着两次没改成就不再改，改不动的（外部接口没授权、网络不通）也不该反复交给编码助手。
 */
const run = promisify(execFile);
const ROOT = process.cwd();
const PI = process.env.DONGNI_PI_BIN || path.join(os.homedir(), ".local", "bin", "pi");
const LOG = path.join(ROOT, "logs", "self-repair.log");
const RESULT = path.join(ROOT, "data", "rebuild-result.json");

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

async function touchedProtected(good: string) {
  const tracked = (await git("diff", "--name-only", good)).stdout.split("\n").filter(Boolean);
  const untracked = (await git("ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean);
  return [...tracked, ...untracked].filter((f) => PROTECTED.includes(f) || PROTECTED_DIRS.some((d) => f.startsWith(d)));
}

const state = ((globalThis as unknown as { __dongniRepair?: { running: string | null } }).__dongniRepair ??= { running: null });

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

const git = (...args: string[]) => run("git", args, { cwd: ROOT, maxBuffer: 20 << 20 });

async function head() {
  return (await git("rev-parse", "HEAD")).stdout.trim();
}

function piPrompt(request: string) {
  return `你在修改「懂你」这个应用自己的代码（你就是这个应用里的 AI 伙伴，现在要改自己）。项目根目录：${ROOT}
先读 README.md 了解结构。日志在 logs/dongni.log（运行日志）和 logs/self-repair.log。

用户的要求：
${request}

约束：
- 只改这个项目里的代码。不要动 data/、logs/、.next/、node_modules/，不要删用户数据。
- 以下「内核」文件不许改，改了整次会被作废退回：${PROTECTED.join("、")}。需要新的存储就在别的模块里用 db() 建新表（CREATE TABLE IF NOT EXISTS），或用 kv 表。
- 改完会自动重启并做健康检查（打开首页、/api/health），检查不过会自动退回。所以首页和 lib/chat.ts 里的 selfTest() 必须保持能用。
- 不许给她加任何限制：回复字数上限、发消息的次数/间隔/时段、沉默规则、按关键词裁工具、截短她记得的对话……他明确说过不要。要解决「啰嗦」「打扰」这类问题，改她的说话方式和判断，不要加硬卡。
- 怎么干活最快：直接读相关文件、改、跑 pnpm typecheck，就够了。不要另搭测试脚手架、不要自己写测试脚本去跑（尤其别在脚本里真的设定时器、真的调接口）；不要开浏览器、截图或做界面验证；搜文件只在本项目目录里搜，别在整个用户目录里 find/grep。
- 保持原有设计原则：输入方便、动效好看、页面干净、非必要的东西不出现、响应快、不丢东西。不要顺手加没被要求的文案或功能。
- 不要运行 pnpm build、不要重启服务、不要 git commit——这些外面会自动做。
- 改完必须运行 pnpm typecheck，确保通过。
- 最后用中文、大白话、三五句话告诉用户你改了什么（不要贴代码）。如果判断不该改或改不了，说明原因。`;
}

/**
 * 跑 pi。用 json 模式把每一步都记到 logs/pi/ 下，慢在哪一步事后能查：
 * 一共几步、模型想了多久、命令跑了多久、最慢的是哪条。
 */
/** 卡住的判定：这么久没有任何输出，就当这条连接死了，杀掉重来（曾经有次干了等 57 分钟） */
const STALL_MS = Number(process.env.DONGNI_STALL_MS ?? 180_000);

async function runPi(request: string): Promise<string> {
  try {
    return await runPiOnce(request);
  } catch (e) {
    if (!/STALLED/.test(String(e))) throw e;
    log("上一轮卡在网络上，重来一遍（已经改到磁盘上的文件还在）");
    return await runPiOnce(
      `${request}\n\n（刚才那一轮卡在网络上了，代码可能已经改了一部分。先看现在代码的真实状态，接着改完，别从头再来一遍）`,
    );
  }
}

/**
 * 子进程的 locale 由我们补：服务的父进程是 launchd，环境里没有 LANG，
 * Ruby/Python 一类子进程拿到中文会按 ASCII-8BIT 处理，一编码就崩（clacky 就栽在这上面）。
 * Node 自己不在乎，但编译脚本、三方 CLI 在乎。
 */
const utf8Env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  LANG: process.env.LANG || "en_US.UTF-8",
  LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
  RUBYOPT: [process.env.RUBYOPT, "-Eutf-8"].filter(Boolean).join(" "),
});

/** 明细落盘：长字段（工具结果、提示词）截短，但整行还是合法 JSON，事后能解析 */
function slimJson(v: unknown) {
  return JSON.stringify(v, (_k, x) => (typeof x === "string" && x.length > 1500 ? `${x.slice(0, 1500)}…（共 ${x.length} 字）` : x));
}

async function runPiOnce(request: string): Promise<string> {
  const dir = path.join(ROOT, "logs", "pi");
  fs.mkdirSync(dir, { recursive: true });
  const trace = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-p", "--no-session", "--no-mcp", "--no-skills", ...piModelArgs(), "--mode", "json", "--thinking", "high", piPrompt(request)], {
      cwd: ROOT,
      env: utf8Env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let err = "";
    let finalText = "";
    let lastAt = Date.now();
    let stalled = false;
    /** pi 最后一条回话是怎么结束的：error / aborted 说明它其实没干完，只是进程正常退出了 */
    let stopReason = "";
    let steps = 0;
    let toolMs = 0;
    const toolStart = new Map<string, { at: number; what: string }>();
    let slowest = { ms: 0, what: "" };
    const onEvent = (e: Record<string, unknown>, at: number) => {
      const type = e.type as string;
      if (type === "turn_start") steps++;
      if (type === "tool_execution_start") {
        const args = JSON.stringify(e.args ?? {}).slice(0, 120);
        toolStart.set(String(e.toolCallId), { at, what: `${e.toolName} ${args}` });
      }
      if (type === "tool_execution_end") {
        const st = toolStart.get(String(e.toolCallId));
        if (st) {
          const ms = at - st.at;
          toolMs += ms;
          if (ms > slowest.ms) slowest = { ms, what: st.what };
        }
      }
      if (type === "message_end") {
        const m = e.message as { role?: string; content?: unknown; stopReason?: string };
        if (m?.role === "assistant") {
          stopReason = String(m.stopReason ?? "");
          const c = m.content;
          const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join("") : "";
          if (text.trim()) finalText = text.trim();
        }
      }
    };
    // 看门狗：连接挂死时 pi 自己不设超时，会一直干等（曾经一次等了 57 分钟）
    const stopWatchdog = stallWatchdog({
      stallMs: STALL_MS,
      touch: () => lastAt,
      onStall: () => {
        stalled = true;
        log(`pi 卡住了：${Math.round((Date.now() - lastAt) / 1000)} 秒没有任何输出（已跑 ${Math.round((Date.now() - t0) / 1000)} 秒），杀掉重来`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      },
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const at = Date.now();
      lastAt = at;
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          // message_update 是逐字增量，太多了，不落盘
          if (e.type !== "message_update") fs.appendFileSync(trace, slimJson({ t: at - t0, ...e }) + "\n");
          onEvent(e, at);
        } catch {
          // 不是 json 的行忽略
        }
      }
    });
    child.stderr.on("data", (b) => {
      lastAt = Date.now();
      err += b;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      stopWatchdog();
      if (stalled) return reject(new Error(`STALLED：连着 ${Math.round(STALL_MS / 1000)} 秒没动静（一共跑了 ${Math.round((Date.now() - t0) / 1000)} 秒），已杀掉`));
      const total = Date.now() - t0;
      const sec = (ms: number) => `${Math.round(ms / 1000)} 秒`;
      log(
        `pi 退出 code=${code}｜用时 ${sec(total)}，${steps} 步，模型思考约 ${sec(total - toolMs)}，跑命令 ${sec(toolMs)}；最慢一步 ${sec(slowest.ms)}：${slowest.what}｜明细 ${path.relative(ROOT, trace)}\n--- 结果 ---\n${finalText}\n--- stderr ---\n${err.slice(-4000)}`,
      );
      // 进程正常退出不等于干完了：最后一句是连接出错 / 被中止，或者压根没给结论，都按没改成算，
      // 不能记成「看过了，不用改」——不然下一轮又会把同一件事提一遍
      if (code === 0 && (stopReason === "error" || stopReason === "aborted"))
        reject(new Error(`pi 半路出错了（${stopReason}），没干完：${finalText.slice(-300) || "没有结论"}`));
      else if (code === 0 && !finalText) reject(new Error("pi 退出了，但没给任何结论"));
      else if (code === 0) resolve(finalText);
      else reject(new Error(`pi 退出码 ${code}：${(err || finalText).slice(-500)}`));
    });
  });
}

/** pi 改完后的硬检查：不许自己提交/改历史，不许碰内核 */
async function guard(good: string) {
  if ((await head()) !== good) throw new Error("改动里动了版本历史，不允许");
  const bad = await touchedProtected(good);
  if (bad.length) throw new Error(`改动碰到了不允许改的内核文件：${bad.join("、")}`);
}

export function repairRunning() {
  return state.running;
}

/** 后台改代码的真实状态（给她看，免得她说「在修」其实啥也没在跑） */
export function repairStatus() {
  const q = queue();
  const lastAt = Number(getKv("repair_last_at") ?? 0);
  const ago = (t: number) => `${Math.max(1, Math.round((Date.now() - t) / 60000))} 分钟前`;
  const lines = [
    state.running
      ? `正在改：「${state.running}…」（${ago(Number(getKv("repair_started_at") ?? Date.now()))}开始的）`
      : "现在后台没有在改任何东西。",
  ];
  if (q.length) lines.push(`排队等着改的还有 ${q.length} 件：${q.map((x) => `「${x.slice(0, 24)}…」`).join("、")}`);
  if (lastAt) lines.push(`上一次改完是 ${ago(lastAt)}：${getKv("repair_last_result") ?? ""}`);
  return lines.join("\n");
}

/** 改动排队：正在改的时候来的新要求先存起来（存库里，重启也不丢），一个改完接着下一个 */
function queue(): string[] {
  try {
    return JSON.parse(getKv("repair_queue") || "[]");
  } catch {
    return [];
  }
}

/** 改过的记录：同一件事改不成就别一遍遍再交出去（日志里同一个天气兜底交了 5 次、抓 GitHub 那件 6 次） */
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

/** 已经提交、等重启体检出结果的那次改动 */
const COMMITTED_KEY = "repair_committed_request";

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

/** 代码目录里有没有别人没提交的改动（data/、logs/ 都在忽略规则里，不算） */
async function dirtyFiles() {
  return (await git("status", "--porcelain")).stdout.split("\n").filter(Boolean);
}

function dirtyNow() {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** 改到一半退回：用 stash 留底，不删任何东西；万一是别人的改动混进来了，也能从 stash 里找回 */
async function shelve(why: string) {
  if (!(await dirtyFiles()).length) return;
  await git("stash", "push", "--include-untracked", "-m", `自我修复退回留底：${why.slice(0, 60)}`).catch((e) =>
    log(`stash 留底失败：${e instanceof Error ? e.message : e}`),
  );
}

/** 正在进行中的那次改动，记在库里：pi 跑到一半服务被重启了，回来能收拾干净 */
const INFLIGHT_KEY = "repair_inflight";
type Inflight = { request: string; good: string; taskId: number; at: number };

/** 她自己回看后决定的改进：标着这个的一律不改（他 2026-11-03 定的：只改他让改的） */
const SELF_INITIATED = "（这是你自己回看后决定的改进）";

export function drainRepairQueue() {
  if (state.running) return;
  const q = queue().filter((r) => !r.includes(SELF_INITIATED));
  const next = q.shift();
  setKv("repair_queue", JSON.stringify(q));
  if (next) startRepair(next);
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
  if (state.running) {
    if (queue().some((q) => similar(q, request) >= 0.6))
      return "同样的事已经在排队了，这次没有重复交。如实告诉对方前面排着呢。";
    setKv("repair_queue", JSON.stringify([...queue(), request]));
    return "前面还有一处正在改，这个已经排上队了：前一个改完（可能会重启一下）就接着改这个。如实告诉对方要排一会儿。";
  }
  // 代码目录里有别人（他、或者别的助手）没提交的改动：不再因此排队干等——他要的是说改就改。
  // 先把现有改动原样提交成一笔留底，再开工；她自己的改动另成一笔，退回时只撤她那一笔，别人的东西不丢。
  const dirty = dirtyNow();
  if (dirty.length) {
    try {
      execFileSync("git", ["add", "-A"], { cwd: ROOT });
      execFileSync("git", ["commit", "-q", "-m", `自我修复前留底：${dirty.length} 个文件有没提交的改动`], { cwd: ROOT });
      log(`代码目录里有没提交的改动，先提交留底再开工：${dirty.slice(0, 8).join(" ")}`);
    } catch (e) {
      log(`留底提交没成（${e instanceof Error ? e.message : e}），照样开工`);
    }
  }
  state.running = request.slice(0, 40);
  setKv("repair_started_at", String(Date.now()));
  // 任务栏：要重启的话这件由重启回来的 reportRebuild 收尾
  const taskId = startTask("repair", `改自己：${request.replace(/\s+/g, " ").slice(0, 30)}`);
  setKv("repair_task_id", String(taskId));
  let restarting = false;
  let taskOk = false;
  void (async () => {
    let good = "";
    try {
      log(`==== 开始：${request}`);
      good = await head();
      setKv(INFLIGHT_KEY, JSON.stringify({ request, good, taskId, at: Date.now() } satisfies Inflight));

      let summary = await runPi(request);
      await guard(good);
      const changed = (await git("status", "--porcelain")).stdout.trim();
      if (!changed) {
        await say(`你看了一圈，这次没有改代码。编码助手的说明：${summary}`, "看了一圈，这次没动代码。");
        taskOk = true;
        noteAttempt(request, false); // 没动代码也不算解决了：同一件事别再一遍遍交出去
        return;
      }
      try {
        await run("pnpm", ["typecheck"], { cwd: ROOT, maxBuffer: 20 << 20 });
      } catch (e) {
        // 类型检查没过：让 pi 再修一次
        const msg = (e as { stdout?: string }).stdout?.slice(-3000) ?? String(e);
        log(`typecheck 失败，让 pi 再修：\n${msg}`);
        summary = await runPi(`${request}\n\n（上一轮改完 pnpm typecheck 没通过，报错如下，请修好）\n${msg}`);
        await guard(good);
        await run("pnpm", ["typecheck"], { cwd: ROOT, maxBuffer: 20 << 20 });
      }
      await git("add", "-A");
      await git("commit", "-q", "-m", `自我修复：${request.slice(0, 60)}`);
      const fix = await head();
      setKv(INFLIGHT_KEY, "");
      // 成没成等重启体检回来再记（reportRebuild）：这里只是提交了，体检不过会被退回。
      // 以前提交时就记成「改好了」，退回之后同一件事 24 小时内再提会被「今天刚改好过」挡掉
      setKv(COMMITTED_KEY, request.slice(0, 300));
      setKv("repair_summary", summary);
      log("提交完成，后台重新编译并重启");
      // 正在打电话就先别重启（重启会把电话挂断），挂了再重启；但不能一直等——挂了电话这件事本身也可能正是这次改的内容
      await waitIdle();
      if (onCall()) {
        await say(
          `你刚把自己改好了，但你正在打电话，我不挂你电话：等你挂了我就重启，半分钟回来。改了什么（编码助手的说明，挑他关心的说一句就够）：${summary}`,
          "改好啦，你还在打电话，我不挂你，等你挂了我再重启～",
        );
        log("在通话，等挂断再重启（最多等 12 分钟）");
        await Promise.race([whenOffCall(), new Promise((ok) => setTimeout(ok, 12 * 60_000))]);
        if (onCall()) log("等了 12 分钟还没挂断，先重启（这通电话会被打断）");
      } else {
        await say(
          `你刚把自己改好了，马上要重启，半分钟左右回来。改了什么（编码助手的说明，挑他关心的说一句就够）：${summary}`,
          "改好啦，我重启一下，半分钟就回来～",
        );
      }
      // 新起一个进程组去编译重启，自己被重启也不影响它
      restarting = true;
      const child = spawn("/bin/bash", [path.join(ROOT, "scripts", "rebuild.sh"), good, fix], {
        cwd: ROOT,
        env: utf8Env(),
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`失败：${msg}`);
      if (good) {
        await shelve(request);
        setKv(INFLIGHT_KEY, "");
        noteAttempt(request, false);
      }
      await say(`这次改自己没改成，已经退回原样，什么都没坏。原因（技术细节别说）：${msg.slice(0, 200)}`, "这次没改成，已经退回原样了，啥也没坏。");
    } finally {
      state.running = null;
      setKv("repair_last_at", String(Date.now()));
      setKv("repair_last_result", `${restarting ? "改完提交了，正在重启体检，结果还没出来" : "没改成或没改动"}（${request.slice(0, 30)}…）`);
      if (!restarting) finishTask(taskId, taskOk, taskOk ? "看过了，没动代码" : "没改成，已退回原样");
      // 要重启的话交给重启后的新进程接着改，否则这里直接接着改下一个
      if (!restarting) setTimeout(drainRepairQueue, 1000);
    }
  })();
  return "已经交给编码助手开始改了。改代码要几分钟，改好会在对话里告诉对方，然后自动重启。";
}

/**
 * 重启前等手上的事做完：电话（单独处理）、派出去的活、正在生成的回复。
 * 不然派活被拦腰杀掉，回复被重启后重新生成还会把工具再调一遍。最多等 15 分钟。
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
 * 启动时收拾：上一次 pi 跑到一半服务被重启了（pi 跟着服务一起没了），
 * 改了一半的文件 stash 留底，任务栏那件收尾，免得下一次把半成品当成「好的版本」。
 */
export function recoverInterruptedRepair() {
  let r: Inflight | null = null;
  try {
    r = JSON.parse(getKv(INFLIGHT_KEY) || "null") as Inflight | null;
  } catch {}
  if (!r || state.running) return;
  setKv(INFLIGHT_KEY, "");
  log(`上次改到一半服务被重启了，收拾掉：${r.request}`);
  void shelve(r.request).then(() => {
    noteAttempt(r.request, false);
    finishTask(r.taskId, false, "改到一半服务重启了，没改成，已退回");
    setKv("repair_last_at", String(Date.now()));
    setKv("repair_last_result", `没改成：改到一半被重启打断（${r.request.slice(0, 30)}…）`);
  });
}

/** 启动时：如果是自我修复后的重启，把结果告诉用户 */
export function reportRebuild() {
  recoverInterruptedRepair();
  if (!fs.existsSync(RESULT)) return;
  try {
    const r = JSON.parse(fs.readFileSync(RESULT, "utf8")) as { ok: boolean; reason?: string };
    const what = r.ok
      ? ["你重启回来了，刚才改的已经生效，可以让他试试。", "我回来啦，改好的已经能用了，你试试～"]
      : ["你重启回来了，但新改的没通过，已经退回改之前的样子，一切照旧。", "我回来了，不过新改的没成，已经退回原样了。"];
    // 这是状态播报，不能被「跟刚才那句太像」的闸门吞掉
    void say(what[0], what[1], { fresh: true });
    finishTask(Number(getKv("repair_task_id") ?? 0), r.ok, r.ok ? "改好了，已生效" : "新改的没通过，已退回");
    const committed = getKv(COMMITTED_KEY);
    if (committed) {
      noteAttempt(committed, r.ok);
      setKv(COMMITTED_KEY, "");
    }
    setKv("repair_last_result", r.ok ? "改好了，已经生效" : "新改的没通过体检，已经退回原样");
    log(`重启完成 ok=${r.ok}`);
  } finally {
    fs.rmSync(RESULT, { force: true });
    if (getKv("repair_summary")) setKv("repair_summary", "");
  }
}
