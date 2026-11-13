import "server-only";

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamChat, type ChatMessage, type ToolCall } from "./llm";

/**
 * 内置执行器：自己拿 DeepSeek 跑 agent 循环，不再外挂 clacky。
 *
 * 为什么要自己写：以前「派活」= spawn 一个 clacky CLI 进程。它是 Ruby 写的、装在用户目录的
 * gem 里，服务的父进程是 launchd（没有 LANG），一句中文就能让它编码崩掉、0 秒退出；
 * 而且本机只有它一个执行器，它一坏，派活整条线全灭。现在执行器就在这个进程里，用的是
 * 跟聊天同一份 config/llm.json，模型换一个、编码、单点依赖，三件事一起没了。
 *
 * 边界：只在他自己的主目录里动手，凭证目录不碰，危险命令直接拒。
 */

const HOME = os.homedir();
const MAX_STEPS = 60;
const SHELL_MS = 180_000;
const OUT_CLIP = 12_000;

/** 子进程补 locale：launchd 起来的环境没有 LANG，很多命令行工具拿到中文会乱码甚至崩 */
function shellEnv(): NodeJS.ProcessEnv {
  const utf8 = "en_US.UTF-8";
  return {
    ...process.env,
    LANG: process.env.LANG || utf8,
    LC_ALL: process.env.LC_ALL || utf8,
    // 别让交互式提示卡住：git 要密码、npm 要确认，一律当拒绝
    GIT_TERMINAL_PROMPT: "0",
    npm_config_yes: "true",
    CI: "1",
  };
}

const clip = (s: string, max = OUT_CLIP) =>
  s.length > max ? `${s.slice(0, max - 2_000)}\n……（中间省略 ${s.length - max} 字）……\n${s.slice(-2_000)}` : s;

/** 她自己的代码目录：后台的活不进来改（改自己走 repair_self，那边有内核保护、类型检查和回滚） */
const SELF_ROOT = process.cwd();

function inHome(dir: string, p: string, write = false): string {
  const abs = path.resolve(dir, (p || ".").replace(/^~(?=\/|$)/, HOME));
  if (abs !== HOME && !abs.startsWith(HOME + path.sep)) throw new Error(`只能在他的主目录里干活：${abs}`);
  if (write && (abs === SELF_ROOT || abs.startsWith(SELF_ROOT + path.sep))) throw new Error("这个目录是聊天应用自己的代码，不许改。");
  if (/\/\.(ssh|gnupg|aws|kube|config\/gcloud)(\/|$)/.test(abs)) throw new Error("这个路径里是密钥/凭证，不碰。");
  return abs;
}

/** 掐整个进程组：bash 底下的 npm run dev、sleep、curl 这些孙子进程也一起走，不然它们会一直挂着 */
function killTree(pid: number | undefined) {
  if (!pid) return;
  const hit = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  hit("SIGTERM");
  setTimeout(() => hit("SIGKILL"), 3_000).unref?.();
}

/** 跑之前要他点头的命令：删东西、改写历史、强推、发布、动系统服务——做了就收不回来 */
const RISKY: { re: RegExp; why: string }[] = [
  { re: /\bgit\s+push\b[^\n;|&]*(\s--force\b|\s--force-with-lease\b|\s-f\b|\s\+\S)/, why: "强推会覆盖远端的历史" },
  { re: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*f|\bgit\s+checkout\s+(--\s+)?\.(\s|$)|\bgit\s+restore\s+(--\S+\s+)*\.(\s|$)/, why: "会丢掉没提交的改动" },
  { re: /\bgit\s+branch\s+-D\b|\bgit\s+push\b[^\n;|&]*\s--delete\b/, why: "会删分支" },
  { re: /\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b/, why: "会对外发布" },
  { re: /\b(chmod|chown)\s+-R\b|\blaunchctl\s+(bootout|remove|unload|disable)\b|\bkillall\b|\bdiskutil\b|\bdefaults\s+(write|delete)\b/, why: "会动系统或别的程序" },
  { re: /\b(brew|npm|pnpm)\s+(uninstall|remove|rm)\s+(-g|--global)\b|\bbrew\s+uninstall\b/, why: "会卸掉装在全局的东西" },
  { re: /\bfind\b[^\n;|&]*\s-delete\b|\bxargs\s+(-\S+\s+)*rm\b|\btruncate\b|\bshred\b/, why: "会批量删东西" },
];

/** rm：只删工作目录里面、写明了名字的东西就放行（清 node_modules、dist 这类）；带通配、往上跳、绝对路径、主目录的都要问 */
function riskyRm(cmd: string, dir: string): boolean {
  for (const m of cmd.matchAll(/(?:^|[;&|(]\s*|\s)rm\s+([^;&|\n]*)/g)) {
    const args = m[1].trim().split(/\s+/).filter(Boolean);
    const targets = args.filter((a) => !a.startsWith("-"));
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    if (!targets.length) continue;
    const inside = targets.every((t) => !/[~$*?`]|\.\.|^\//.test(t.replace(/^["']|["']$/g, "")));
    if (!inside || (recursive && dir === HOME)) return true;
  }
  return false;
}

function riskOf(cmd: string, dir: string): string | null {
  if (riskyRm(cmd, dir)) return "会删掉工作目录以外、或者没写明名字的东西";
  return RISKY.find((r) => r.re.test(cmd))?.why ?? null;
}

const YES = /好的?|行|可以|同意|没问题|批准|跑吧|执行吧|删吧|ok|okay|yes|sure/i;
const NO = /不用|不要|别|先不|算了|不行|不可以|等等|no\b/i;

async function runShell(dir: string, cmd: string, timeoutMs = SHELL_MS, signal?: AbortSignal, ask?: WorkerAsk): Promise<string> {
  const banned = /(^|\s)(sudo|mkfs|shutdown|reboot|halt)\b|\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\/|~\/?)(\s|$)|\bdd\s+if=|:\(\)\s*\{|>\s*\/dev\/(sd|disk)/;
  if (banned.test(cmd)) return "[拒绝] 这条命令会动系统或删根目录/主目录，不执行。换个做法。";
  // 她自己的代码目录：命令里也不许改（改自己走 repair_self）
  if (cmd.includes(SELF_ROOT) && /(>|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\btee\b|\bpatch\b|\bgit\s+(commit|checkout|reset|apply|stash|restore|clean)\b)/.test(cmd))
    return "[拒绝] 这条命令会改聊天应用自己的代码目录，不执行。";
  if (signal?.aborted) return "[已叫停] 没执行。";
  const risk = riskOf(cmd, dir);
  if (risk) {
    if (!ask) return `[拒绝] 这条命令${risk}，现在没法问他，不执行。换个不可逆程度低的做法，或者收尾说清楚。`;
    const answer = (await ask(`要跑一条收不回来的命令（${risk}）：\n${cmd.slice(0, 600)}\n可以跑吗？`)).trim();
    if (signal?.aborted) return "[已叫停] 没执行。";
    if (!answer || NO.test(answer) || !YES.test(answer))
      return `[没批准] 他的回答是：「${answer || "（一直没回）"}」。这条命令没执行。按他的意思换个做法，或者收尾说清楚。`;
  }

  return new Promise((resolve) => {
    // detached：自成一个进程组，超时/叫停时才能连孙子进程一起掐掉
    const child = spawn("/bin/bash", ["-lc", cmd], { cwd: dir, env: shellEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let done = false;
    const onAbort = () => {
      killTree(child.pid);
      finish("\n[已叫停] 这件活被停下了，命令已经掐掉。");
    };
    const finish = (tail: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(clip(out + tail) || "（没有输出）");
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(`\n[超时] 超过 ${Math.round(timeoutMs / 1000)} 秒，已经掐掉了。`);
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", (e) => finish(`\n[起不来] ${e.message}`));
    child.on("close", (code) => finish(code ? `\n[退出码 ${code}]` : ""));
  });
}

type Args = Record<string, unknown>;
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "在当前工作目录下跑一条 shell 命令（bash -lc），返回合并后的 stdout/stderr。装依赖、跑测试、git、编译都用它。",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "要执行的命令，可以是多行脚本" },
          timeout_ms: { type: "number", description: "超时毫秒，默认 180000，最长 600000" },
        },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读一个文本文件。大文件用 offset/limit 分页读，别一次拉几万行。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录或绝对路径" },
          offset: { type: "number", description: "从第几行开始（1 起），默认 1" },
          limit: { type: "number", description: "读多少行，默认 400" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "整份写入文件（覆盖）。会自动建目录。写代码、写文档用这个。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "精确替换：把文件里的 old 原文换成 new。old 必须唯一命中，改代码优先用它而不是整份重写。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old: { type: "string", description: "要替换的原文，必须和文件里一模一样（含缩进）" },
          new: { type: "string" },
        },
        required: ["path", "old", "new"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "列目录，带文件大小。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "默认当前工作目录" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "按文件名/内容找文件。pattern 是通配符（如 *.tsx），或给 content 做全文搜索。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "文件名通配符，默认 *" },
          content: { type: "string", description: "要搜索的文件内容关键词，给了就按内容找" },
          path: { type: "string", description: "在哪个目录里找，默认当前工作目录" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report_progress",
      description: "报一个真实的阶段性进展（一句话）：比如「依赖装好了，开始跑测试」「十个文件生成了六个」。只在真走完一段时报，别为了报而报。",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "停下来问他一个问题，等他回答再继续。只在真拿不准、而且猜错代价大的时候用：需求有两种理解、要在几个方案里选、要花钱或对外发东西。能自己判断的别问。",
      parameters: { type: "object", properties: { question: { type: "string", description: "问题写完整，他不看上下文也能答" } }, required: ["question"] },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "活干完了（或确定干不下去）就调它，把结果说清楚：做了什么、产物在哪、有没有遗留问题。这是唯一能让任务结束的方式。",
      parameters: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "真的做成了吗" },
          summary: { type: "string", description: "给他看的中文汇报，两三句，说清结果和产物路径" },
        },
        required: ["ok", "summary"],
      },
    },
  },
];

/** 问他一句，等到回答；一直没回就返回空串 */
export type WorkerAsk = (question: string) => Promise<string>;
type ToolEnv = { signal?: AbortSignal; ask?: WorkerAsk; progress?: (text: string) => void };

async function execTool(dir: string, call: ToolCall, env: ToolEnv = {}): Promise<string> {
  const { signal } = env;
  const name = call.function.name;
  let a: Args = {};
  try {
    a = JSON.parse(call.function.arguments || "{}") as Args;
  } catch {
    return "[参数不是合法 JSON，重发一次]";
  }
  try {
    switch (name) {
      case "run_shell": {
        const cmd = str(a.cmd).trim();
        if (!cmd) return "[cmd 是空的]";
        return await runShell(dir, cmd, Math.min(num(a.timeout_ms, SHELL_MS), 600_000), signal, env.ask);
      }
      case "read_file": {
        const abs = inHome(dir, str(a.path));
        const offset = Math.max(1, num(a.offset, 1));
        const limit = Math.min(num(a.limit, 400), 2_000);
        const all = fs.readFileSync(abs, "utf8").split("\n");
        const part = all.slice(offset - 1, offset - 1 + limit);
        const more = offset - 1 + limit < all.length ? `\n……（还有 ${all.length - (offset - 1 + limit)} 行，用 offset=${offset + limit} 接着读）` : "";
        return clip(part.map((l, i) => `${offset + i}\t${l}`).join("\n") + more);
      }
      case "write_file": {
        const abs = inHome(dir, str(a.path), true);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const body = str(a.content);
        fs.writeFileSync(abs, body, "utf8");
        return `写好了：${abs}（${body.length} 字）`;
      }
      case "edit_file": {
        const abs = inHome(dir, str(a.path), true);
        const old = str(a.old);
        const neu = str(a.new);
        if (!old) return "[old 不能为空；要整份重写就用 write_file]";
        const src = fs.readFileSync(abs, "utf8");
        const hits = src.split(old).length - 1;
        if (hits === 0) return `[没找到这段原文] 文件 ${abs} 里没有匹配：${old.slice(0, 120)}`;
        if (hits > 1) return `[不唯一] 这段在文件里出现了 ${hits} 次，把 old 写长一点再试。`;
        fs.writeFileSync(abs, src.replace(old, neu), "utf8");
        return `改好了：${abs}`;
      }
      case "list_dir": {
        const abs = inHome(dir, str(a.path, "."));
        const rows = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
          const st = fs.statSync(path.join(abs, e.name), { throwIfNoEntry: false });
          const size = st && !e.isDirectory() ? `${Math.round(st.size / 1024)}k` : "";
          return `${e.isDirectory() ? "d" : "-"} ${e.name}${e.isDirectory() ? "/" : ""} ${size}`.trim();
        });
        return clip(rows.join("\n") || "（空目录）");
      }
      case "find_files": {
        const base = inHome(dir, str(a.path, "."));
        const pattern = str(a.pattern, "*");
        const content = str(a.content);
        const re = content ? new RegExp(content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
        const hits: string[] = [];
        const walk = (d: string, depth: number) => {
          if (hits.length >= 200 || depth > 6) return;
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === "node_modules" || e.name === ".git" || e.name === ".next") continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
              walk(p, depth + 1);
              continue;
            }
            if (re) {
              const st = fs.statSync(p, { throwIfNoEntry: false });
              if (!st || st.size > 2_000_000) continue;
              try {
                if (re.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(dir, p));
              } catch {}
            } else if (globish(pattern, e.name)) hits.push(path.relative(dir, p));
          }
        };
        walk(base, 0);
        return hits.length ? hits.join("\n") : "（没找到）";
      }
      case "report_progress": {
        const text = str(a.text).trim();
        if (text) env.progress?.(text);
        return "记下了，接着干。";
      }
      case "ask_user": {
        const q = str(a.question).trim();
        if (!q) return "[question 是空的]";
        if (!env.ask) return "[现在问不到他] 自己判断，宁可保守。";
        const answer = (await env.ask(q)).trim();
        return answer ? `他的回答：${answer}` : "他一直没回。自己判断，宁可保守；拿不准的那部分就不做，收尾时说清楚。";
      }
      case "finish":
        return "OK";
      default:
        return `[没有这个工具：${name}]`;
    }
  } catch (e) {
    return `[出错] ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 只支持 * 和 ? 的轻量通配，够用来找文件了 */
function globish(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
  );
  return re.test(name);
}

function systemPrompt(dir: string, task: string) {
  return `你是一个在本机干活的执行器（不是聊天助手）。现在的工作目录是 ${dir}。

任务（这是他原话，别改写它的意图）：
${task}

规矩：
1. 自己动手，别只给建议。能跑命令就真跑，别猜；不确定就先看一眼现状。
2. 一次一步：先看（ls/read/grep），再改，改完验证（跑起来、跑测试、cat 出来看）。
3. 改代码用 edit_file 精确替换，只有新建文件或整份重写才用 write_file。
4. 命令输出很长时不要反复全量读，用 head/grep 收窄。
5. 能自己判断的自己判断，宁可保守。真拿不准、猜错代价又大的（需求有两种理解、要花钱、要对外发东西），用 ask_user 问他一句再继续。删东西、强推、改写 git 历史这类收不回来的命令，跑的时候会自动先问他，他不同意就换做法。
5b. 走完一段真实的阶段就用 report_progress 报一句（装好了、跑通了、生成到第几个）；他中途补的话会以「他刚补了一句」的形式出现，以最新的为准。
6. 只碰这个任务需要的东西，别顺手重构别人没让你动的地方。${SELF_ROOT} 这个目录里的文件一律不许改（命令里也不许）。
7. 撞到死路上（连续两次同样的失败）就换方案；换不动就收尾说清楚卡在哪。
8. 干完必须调 finish：ok 表示真做成了，summary 里写清做了什么、产物在哪（给绝对路径或相对工作目录的路径）、遗留什么。他不会看你的中间过程，只会看 summary。

注意：你可以说中文，命令尽量用非交互方式（-y、--no-pager 之类），否则会卡住。`;
}

export type WorkerLog = (entry: { type: string; [k: string]: unknown }) => void;

/** 会真改东西的工具：一次都没调过就说「做完了」，那只是嘴上做完 */
const SIDE_EFFECT_TOOLS = new Set(["run_shell", "write_file", "edit_file"]);
export const NO_ACTION_PREFIX = "执行器这次没真动手，只给了文字结论";

const STEP_TRIES = 3;

function abortError(signal?: AbortSignal) {
  const why = signal?.reason instanceof Error ? signal.reason.message : "被叫停了";
  return Object.assign(new Error(why), { name: "AbortError" });
}

/** 叫停时立刻从等模型里出来：streamChat 不收 signal，只能跟叫停赛跑，输了的那条流自己会超时收掉 */
async function oneStep(messages: ChatMessage[], signal?: AbortSignal): Promise<{ text: string; calls: ToolCall[] }> {
  if (signal?.aborted) throw abortError(signal);
  const it = streamChat(messages, TOOLS)[Symbol.asyncIterator]();
  let off = () => {};
  const stopped = new Promise<never>((_, reject) => {
    const h = () => reject(abortError(signal));
    signal?.addEventListener("abort", h, { once: true });
    off = () => signal?.removeEventListener("abort", h);
  });
  stopped.catch(() => {});
  let text = "";
  let calls: ToolCall[] = [];
  try {
    for (;;) {
      const r = await Promise.race([it.next(), stopped]);
      if (r.done) break;
      if (r.value.type === "text") text += r.value.text;
      else if (r.value.type === "tools") calls = r.value.calls;
    }
  } catch (e) {
    if (signal?.aborted) void it.return?.(undefined)?.catch(() => {});
    throw e;
  } finally {
    off();
  }
  return { text, calls };
}

/** 模型一次超时/断网/5xx 不该把整件活判死：同一步、同一份上下文重来，最多 3 次；4xx 和叫停不重试 */
async function stepWithRetry(messages: ChatMessage[], step: number, say: WorkerLog, signal?: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await oneStep(messages, signal); // 失败那次吐了一半的字直接丢掉，不进上下文
    } catch (e) {
      if (signal?.aborted || (e as { fatal?: boolean }).fatal || attempt >= STEP_TRIES) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      say({ type: "retry", step, attempt, error: msg.slice(0, 300) });
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, 2_000 * attempt);
        signal?.addEventListener("abort", () => (clearTimeout(t), ok()), { once: true });
      });
    }
  }
}

/**
 * 跑一件活，返回给他看的最终结果。
 * 不用 clacky、不留子进程：整个循环在服务进程里，日志逐步写进 jsonl。
 * signal 一叫停：等模型的那一步立刻退出、正在跑的命令连进程组一起掐掉，然后抛 AbortError。
 */
export async function runWorker(opts: {
  task: string;
  dir: string;
  log?: WorkerLog;
  /** 打算多久收手（毫秒），到点就让它总结收尾 */
  budgetMs?: number;
  /** 硬停：超期或他叫停 */
  signal?: AbortSignal;
  /** 问他一句并等回答 */
  ask?: WorkerAsk;
  /** 它报的阶段性进展 */
  progress?: (text: string) => void;
  /** 取走他中途补的话（取一次清一次） */
  notes?: () => string[];
}): Promise<string> {
  const { task, dir, log, signal } = opts;
  const deadline = Date.now() + (opts.budgetMs ?? 20 * 60_000);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(dir, task) },
    { role: "user", content: "开始吧。" },
  ];
  const say = (entry: { type: string; [k: string]: unknown }) => {
    try {
      log?.(entry);
    } catch {}
  };

  let lastText = "";
  let finished = "";
  let acted = 0; // 真动过手的工具调用次数
  // 说做完了却一下都没动过：不能当成功报上去
  const settle = (text: string) => (acted ? text : `${NO_ACTION_PREFIX}：\n${text}`);

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (signal?.aborted) throw abortError(signal);
    if (Date.now() > deadline) {
      // 快到期了：别再让它开新坑，要一句总结
      messages.push({ role: "user", content: "时间到了，别再开新活，立刻调 finish 说清现在做到哪、产物在哪、还剩什么。" });
    }

    // 他中途补的话：下一步之前塞给它
    const notes = opts.notes?.() ?? [];
    if (notes.length) {
      messages.push({ role: "user", content: `他刚补了一句（以这个为准，和前面冲突的按这个改）：\n${notes.join("\n")}` });
      say({ type: "note", step, text: notes.join("\n").slice(0, 800) });
    }

    const { text, calls } = await stepWithRetry(messages, step, say, signal);
    if (text.trim()) lastText = text.trim();
    say({ type: "assistant", step, text: text.slice(0, 2_000) });

    if (!calls.length) {
      // 没叫工具：要么它觉得说完了，要么就是懒。再说一次要 finish，第二次还这样就收。
      if (step > 1 && lastText) {
        say({ type: "done", ok: acted > 0, steps: step, acted });
        return settle(lastText);
      }
      messages.push({ role: "assistant", content: text || "（空）" });
      messages.push({ role: "user", content: "别只说话。要么继续用工具干，要么调 finish 收尾。" });
      continue;
    }

    messages.push({ role: "assistant", content: text, tool_calls: calls });

    for (const call of calls) {
      if (signal?.aborted) throw abortError(signal);
      const result = await execTool(dir, call, { signal, ask: opts.ask, progress: opts.progress });
      if (SIDE_EFFECT_TOOLS.has(call.function.name)) acted++;
      say({ type: "tool", step, name: call.function.name, args: call.function.arguments.slice(0, 800), result: result.slice(0, 1_500) });
      if (call.function.name === "finish") {
        let summary = "";
        let ok = true;
        try {
          const a = JSON.parse(call.function.arguments || "{}") as { ok?: boolean; summary?: string };
          summary = str(a.summary);
          ok = a.ok !== false;
        } catch {}
        finished = summary || lastText || "（它没说清结果）";
        messages.push({ role: "tool", tool_call_id: call.id, content: "已记录。" });
        say({ type: "done", ok: ok && acted > 0, steps: step, acted });
        return ok ? settle(finished) : `没做成：${finished}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  say({ type: "done", ok: false, steps: MAX_STEPS, reason: "步数用完" });
  return `步数用完了（${MAX_STEPS} 步）还没收尾。它最后说的是：\n${lastText || "（没有输出）"}`;
}
