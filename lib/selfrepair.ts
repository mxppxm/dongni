import "server-only";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, getKv, setKv } from "./db";

/**
 * 自我修复：把用户的要求交给 pi（编码 agent）去改本项目的代码，
 * 改完做类型检查 → 提交 → 后台重新编译并重启。任何一步失败都退回修改前的版本。
 */
const run = promisify(execFile);
const ROOT = process.cwd();
const PI = process.env.DONGNI_PI_BIN || path.join(os.homedir(), ".local", "bin", "pi");
const LOG = path.join(ROOT, "logs", "self-repair.log");
const RESULT = path.join(ROOT, "data", "rebuild-result.json");
const PI_TIMEOUT = 25 * 60_000;

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

/** 以「它」的身份往对话里补一条消息（修复进度/结果） */
export function postAssistant(content: string) {
  db()
    .prepare("INSERT INTO messages(role, content, status, extracted, created_at) VALUES('assistant', ?, 'done', 1, ?)")
    .run(content, Date.now());
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
- 保持原有设计原则：输入方便、动效好看、页面干净、非必要的东西不出现、响应快、不丢东西。不要顺手加没被要求的文案或功能。
- 不要运行 pnpm build、不要重启服务、不要 git commit——这些外面会自动做。
- 改完必须运行 pnpm typecheck，确保通过。
- 最后用中文、大白话、三五句话告诉用户你改了什么（不要贴代码）。如果判断不该改或改不了，说明原因。`;
}

async function runPi(request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-p", "--no-session", "--no-mcp", "--thinking", "high", piPrompt(request)], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const timer = setTimeout(() => child.kill("SIGTERM"), PI_TIMEOUT);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      log(`pi 退出 code=${code}\n--- stdout ---\n${out}\n--- stderr ---\n${err.slice(-4000)}`);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`pi 退出码 ${code}：${(err || out).slice(-500)}`));
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
  let restarting = false;
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
        postAssistant(summary || "看了一圈，这次没有改代码。");
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
      postAssistant(`${summary}\n\n我重启一下，半分钟左右回来。`);
      log("提交完成，后台重新编译并重启");
      // 新起一个进程组去编译重启，自己被重启也不影响它
      restarting = true;
      const child = spawn("/bin/bash", [path.join(ROOT, "scripts", "rebuild.sh"), good], {
        cwd: ROOT,
        env: process.env,
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
      postAssistant(`这次没改成，已经退回原样了。原因：${msg.slice(0, 200)}`);
    } finally {
      state.running = null;
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
    if (r.ok) postAssistant("回来了，新版本已经生效。");
    else if (r.reason === "health") postAssistant("新版本重启后自检没通过，我已经退回到修改前的版本，一切照旧。");
    else postAssistant("新代码没编译过，我已经退回到修改前的版本，一切照旧。");
    log(`重启完成 ok=${r.ok}`);
  } finally {
    fs.rmSync(RESULT, { force: true });
    if (getKv("repair_summary")) setKv("repair_summary", "");
  }
}
