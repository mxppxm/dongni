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

export function repairRunning() {
  return state.running;
}

export function startRepair(request: string): string {
  if (state.running) return `已经在改了（${state.running}），等这次改完再说。`;
  state.running = request.slice(0, 40);
  void (async () => {
    let good = "";
    try {
      log(`==== 开始：${request}`);
      await git("add", "-A");
      await git("commit", "-q", "--allow-empty", "-m", `自我修复前：${request.slice(0, 60)}`);
      good = await head();

      let summary = await runPi(request);
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
        await run("pnpm", ["typecheck"], { cwd: ROOT, maxBuffer: 20 << 20 });
      }
      await git("add", "-A");
      await git("commit", "-q", "-m", `自我修复：${request.slice(0, 60)}`);
      setKv("repair_summary", summary);
      postAssistant(`${summary}\n\n我重启一下，半分钟左右回来。`);
      log("提交完成，后台重新编译并重启");
      // 新起一个进程组去编译重启，自己被重启也不影响它
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
      if (good) await git("reset", "--hard", good).catch(() => {});
      postAssistant(`这次没改成，已经退回原样了。原因：${msg.slice(0, 200)}`);
    } finally {
      state.running = null;
    }
  })();
  return "已经开始改了。改代码要几分钟，改好会在对话里告诉对方，然后自动重启。";
}

/** 启动时：如果是自我修复后的重启，把结果告诉用户 */
export function reportRebuild() {
  if (!fs.existsSync(RESULT)) return;
  try {
    const r = JSON.parse(fs.readFileSync(RESULT, "utf8")) as { ok: boolean };
    if (r.ok) postAssistant("回来了，新版本已经生效。");
    else postAssistant("新代码没编译过，我已经退回到修改前的版本，一切照旧。");
    log(`重启完成 ok=${r.ok}`);
  } finally {
    fs.rmSync(RESULT, { force: true });
    if (getKv("repair_summary")) setKv("repair_summary", "");
  }
}
