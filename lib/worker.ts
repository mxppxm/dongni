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

function inHome(dir: string, p: string): string {
  const abs = path.resolve(dir, (p || ".").replace(/^~(?=\/|$)/, HOME));
  if (!abs.startsWith(HOME)) throw new Error(`只能在他的主目录里干活：${abs}`);
  if (/\/\.(ssh|gnupg|aws|kube|config\/gcloud)(\/|$)/.test(abs)) throw new Error("这个路径里是密钥/凭证，不碰。");
  return abs;
}

function runShell(dir: string, cmd: string, timeoutMs = SHELL_MS): Promise<string> {
  const banned = /(^|\s)(sudo|mkfs|shutdown|reboot|halt)\b|\brm\s+-rf\s+\/(\s|$)|\bdd\s+if=|:\(\)\s*\{|>\s*\/dev\/(sd|disk)/;
  if (banned.test(cmd)) return Promise.resolve("[拒绝] 这条命令会动系统或删根目录，不执行。换个做法。");

  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", cmd], { cwd: dir, env: shellEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const finish = (tail: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(clip(out + tail) || "（没有输出）");
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000);
      finish(`\n[超时] 超过 ${Math.round(timeoutMs / 1000)} 秒，已经掐掉了。`);
    }, timeoutMs);
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

async function execTool(dir: string, call: ToolCall): Promise<string> {
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
        return await runShell(dir, cmd, Math.min(num(a.timeout_ms, SHELL_MS), 600_000));
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
        const abs = inHome(dir, str(a.path));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const body = str(a.content);
        fs.writeFileSync(abs, body, "utf8");
        return `写好了：${abs}（${body.length} 字）`;
      }
      case "edit_file": {
        const abs = inHome(dir, str(a.path));
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
5. 别问人——联系不上他，你自己判断，宁可保守。
6. 只碰这个任务需要的东西，别顺手重构别人没让你动的地方。
7. 撞到死路上（连续两次同样的失败）就换方案；换不动就收尾说清楚卡在哪。
8. 干完必须调 finish：ok 表示真做成了，summary 里写清做了什么、产物在哪（给绝对路径或相对工作目录的路径）、遗留什么。他不会看你的中间过程，只会看 summary。

注意：你可以说中文，命令尽量用非交互方式（-y、--no-pager 之类），否则会卡住。`;
}

export type WorkerLog = (entry: { type: string; [k: string]: unknown }) => void;

/**
 * 跑一件活，返回给他看的最终结果。
 * 不用 clacky、不留子进程：整个循环在服务进程里，日志逐步写进 jsonl。
 */
export async function runWorker(opts: {
  task: string;
  dir: string;
  log?: WorkerLog;
  /** 打算多久收手（毫秒），到点就让它总结收尾 */
  budgetMs?: number;
}): Promise<string> {
  const { task, dir, log } = opts;
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

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (Date.now() > deadline) {
      // 快到期了：别再让它开新坑，要一句总结
      messages.push({ role: "user", content: "时间到了，别再开新活，立刻调 finish 说清现在做到哪、产物在哪、还剩什么。" });
    }

    let text = "";
    let calls: ToolCall[] = [];
    for await (const ev of streamChat(messages, TOOLS)) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "tools") calls = ev.calls;
    }
    if (text.trim()) lastText = text.trim();
    say({ type: "assistant", step, text: text.slice(0, 2_000) });

    if (!calls.length) {
      // 没叫工具：要么它觉得说完了，要么就是懒。再说一次要 finish，第二次还这样就收。
      if (step > 1 && lastText) return lastText;
      messages.push({ role: "assistant", content: text || "（空）" });
      messages.push({ role: "user", content: "别只说话。要么继续用工具干，要么调 finish 收尾。" });
      continue;
    }

    messages.push({ role: "assistant", content: text, tool_calls: calls });

    for (const call of calls) {
      const result = await execTool(dir, call);
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
        say({ type: "done", ok, steps: step });
        return ok ? finished : `没做成：${finished}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  say({ type: "done", ok: false, steps: MAX_STEPS, reason: "步数用完" });
  return `步数用完了（${MAX_STEPS} 步）还没收尾。它最后说的是：\n${lastText || "（没有输出）"}`;
}
