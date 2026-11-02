import "server-only";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { piModelArgs } from "./llmconfig";
import { db, getKv, setKv } from "./db";
import { speakAsHer } from "./speak";
import { onCall, whenOffCall } from "./presence";
import { stallWatchdog } from "./stall";
import { finishTask, startTask } from "./tasks";

/**
 * 自我修复：把用户的要求交给 pi（编码 agent）去改本项目的代码，
 * 改完做类型检查 → 提交 → 后台重新编译并重启。任何一步失败都退回修改前的版本。
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
        const m = e.message as { role?: string; content?: unknown };
        if (m?.role === "assistant") {
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
        log(`pi 卡住了：${Math.round(STALL_MS / 1000)} 秒没有任何输出，杀掉重来`);
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
          if (e.type !== "message_update") fs.appendFileSync(trace, JSON.stringify({ t: at - t0, ...e }).slice(0, 4000) + "\n");
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
      if (stalled) return reject(new Error(`STALLED：${Math.round((Date.now() - t0) / 1000)} 秒没动静，已杀掉`));
      const total = Date.now() - t0;
      const sec = (ms: number) => `${Math.round(ms / 1000)} 秒`;
      log(
        `pi 退出 code=${code}｜用时 ${sec(total)}，${steps} 步，模型思考约 ${sec(total - toolMs)}，跑命令 ${sec(toolMs)}；最慢一步 ${sec(slowest.ms)}：${slowest.what}｜明细 ${path.relative(ROOT, trace)}\n--- 结果 ---\n${finalText}\n--- stderr ---\n${err.slice(-4000)}`,
      );
      if (code === 0) resolve(finalText);
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

export function drainRepairQueue() {
  if (state.running) return;
  const q = queue();
  const next = q.shift();
  setKv("repair_queue", JSON.stringify(q));
  if (next) startRepair(next);
}

export function startRepair(request: string): string {
  if (getKv("repair_paused") === "1")
    return "改自己的功能现在被对方暂停了（对方让别人来改）。这次没有交出去，别说你在改；如实告诉对方，你把想法记下了。";
  if (state.running) {
    setKv("repair_queue", JSON.stringify([...queue(), request]));
    return "前面还有一处正在改，这个已经排上队了：前一个改完（可能会重启一下）就接着改这个。如实告诉对方要排一会儿。";
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
      await git("add", "-A");
      await git("commit", "-q", "--allow-empty", "-m", `自我修复前：${request.slice(0, 60)}`);
      good = await head();

      let summary = await runPi(request);
      await guard(good);
      const changed = (await git("status", "--porcelain")).stdout.trim();
      if (!changed) {
        await say(`你看了一圈，这次没有改代码。编码助手的说明：${summary}`, "看了一圈，这次没动代码。");
        taskOk = true;
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
      setKv("repair_summary", summary);
      log("提交完成，后台重新编译并重启");
      // 正在打电话就先别重启（重启会把电话挂断），挂了再重启；但不能一直等——挂了电话这件事本身也可能正是这次改的内容
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
      const child = spawn("/bin/bash", [path.join(ROOT, "scripts", "rebuild.sh"), good], {
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
        await git("reset", "--hard", good).catch(() => {});
        // 改到一半新建的文件也清掉，不然会混进下一次的「修改前」版本
        await git("clean", "-fd", "-e", "data", "-e", "logs").catch(() => {});
      }
      await say(`这次改自己没改成，已经退回原样，什么都没坏。原因（技术细节别说）：${msg.slice(0, 200)}`, "这次没改成，已经退回原样了，啥也没坏。");
    } finally {
      setKv("repair_last_at", String(Date.now()));
      setKv("repair_last_result", `${restarting ? "改好了" : "没改成或没改动"}（${request.slice(0, 30)}…）`);
      state.running = null;
      if (!restarting) finishTask(taskId, taskOk, taskOk ? "看过了，没动代码" : "没改成，已退回原样");
      // 要重启的话交给重启后的新进程接着改，否则这里直接接着改下一个
      if (!restarting) setTimeout(drainRepairQueue, 1000);
    }
  })();
  return "已经开始改了。改代码要几分钟，改好会在对话里告诉对方，然后自动重启。";
}

/** 启动时：如果是自我修复后的重启，把结果告诉用户 */
export function reportRebuild() {
  if (!fs.existsSync(RESULT)) return;
  try {
    const r = JSON.parse(fs.readFileSync(RESULT, "utf8")) as { ok: boolean; reason?: string };
    const what = r.ok
      ? ["你重启回来了，刚才改的已经生效，可以让他试试。", "我回来啦，改好的已经能用了，你试试～"]
      : ["你重启回来了，但新改的没通过，已经退回改之前的样子，一切照旧。", "我回来了，不过新改的没成，已经退回原样了。"];
    // 这是状态播报，不能被「跟刚才那句太像」的闸门吞掉
    void say(what[0], what[1], { fresh: true });
    finishTask(Number(getKv("repair_task_id") ?? 0), r.ok, r.ok ? "改好了，已生效" : "新改的没通过，已退回");
    log(`重启完成 ok=${r.ok}`);
  } finally {
    fs.rmSync(RESULT, { force: true });
    if (getKv("repair_summary")) setKv("repair_summary", "");
  }
}
