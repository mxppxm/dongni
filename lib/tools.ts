import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { addReminder, cancelReminder, pendingReminders, resolveWhen } from "./reminders";
import { startRepair } from "./selfrepair";

/**
 * 查电脑的工具：全部只读，不能改、删、执行任意命令（repair_self 除外，它只改本项目，见 selfrepair.ts）。
 * 密钥、密码、登录凭证类文件一律不读。
 */
const run = promisify(execFile);
const HOME = os.homedir();

const DENY = [
  /\/\.ssh(\/|$)/,
  /\/\.gnupg(\/|$)/,
  /\/\.aws(\/|$)/,
  /\/\.kube(\/|$)/,
  /\/\.docker\/config\.json$/,
  /\/Library\/Keychains(\/|$)/,
  /\/Library\/Cookies(\/|$)/,
  /\/\.pi\/agent\/(models|auth|mcp-auth|models-store)\.json/,
  /\/\.netrc$/,
  /\/\.npmrc$/,
  /\/\.git-credentials$/,
  /(^|\/)\.env(\.[\w-]+)?$/,
  /\/id_(rsa|ed25519|ecdsa)[^/]*$/,
  /\.(pem|key|p12|keychain-db)$/,
  /credentials/i,
];

const MAX_READ = 20_000;

function resolvePath(p: string) {
  const abs = path.resolve(p.startsWith("~") ? path.join(HOME, p.slice(1)) : p);
  if (DENY.some((r) => r.test(abs))) throw new Error("这是密钥/凭证类文件，不读");
  return abs;
}

const fmtTime = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false });
const fmtSize = (n: number) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);
const tilde = (p: string) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

async function listDir({ path: p }: { path: string }) {
  const dir = resolvePath(p || "~");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const rows = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith("."))
      .slice(0, 300)
      .map(async (e) => {
        try {
          const st = await fs.stat(path.join(dir, e.name));
          return { name: e.name + (e.isDirectory() ? "/" : ""), m: st.mtimeMs, s: e.isDirectory() ? "" : fmtSize(st.size) };
        } catch {
          return { name: e.name, m: 0, s: "" };
        }
      }),
  );
  rows.sort((a, b) => b.m - a.m);
  return `${tilde(dir)}（共 ${entries.length} 项，按修改时间从新到旧）\n` + rows.map((r) => `${r.name}  ${r.s}  ${r.m ? fmtTime(r.m) : ""}`).join("\n");
}

const TEXTUTIL = new Set([".doc", ".docx", ".rtf", ".rtfd", ".odt", ".html", ".htm", ".webarchive"]);

async function readFile({ path: p, offset = 0 }: { path: string; offset?: number }) {
  const file = resolvePath(p);
  const st = await fs.stat(file);
  if (st.isDirectory()) return listDir({ path: file });
  const ext = path.extname(file).toLowerCase();
  let text: string;
  if (TEXTUTIL.has(ext)) {
    text = (await run("/usr/bin/textutil", ["-convert", "txt", "-stdout", file], { maxBuffer: 20 << 20 })).stdout;
  } else if (ext === ".pdf") {
    // 系统自带的 Spotlight 已经抽好了 PDF 文字
    text = (await run("/usr/bin/mdls", ["-raw", "-name", "kMDItemTextContent", file], { maxBuffer: 20 << 20 })).stdout;
    if (!text || text === "(null)") return "这个 PDF 没有可读的文字（可能是扫描件）。";
  } else {
    if (st.size > 50 << 20) return `文件太大（${fmtSize(st.size)}），不读。`;
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return `这是二进制文件（${ext || "无扩展名"}，${fmtSize(st.size)}），读不了内容。`;
    text = buf.toString("utf8");
  }
  const part = text.slice(offset, offset + MAX_READ);
  const more = text.length > offset + MAX_READ ? `\n\n……（还有 ${text.length - offset - MAX_READ} 字，可用 offset=${offset + MAX_READ} 接着读）` : "";
  return `${tilde(file)}  ${fmtSize(st.size)}  修改于 ${fmtTime(st.mtimeMs)}\n\n${part}${more}`;
}

async function mdfind(args: string[], limit: number) {
  const { stdout } = await run("/usr/bin/mdfind", args, { maxBuffer: 20 << 20, timeout: 20_000 });
  const files = stdout
    .split("\n")
    .filter(Boolean)
    .filter((f) => !/\/Library\/|\/node_modules\/|\/\.[^/]+\//.test(f) && !DENY.some((r) => r.test(f)))
    .slice(0, limit);
  const rows = await Promise.all(
    files.map(async (f) => {
      try {
        const st = await fs.stat(f);
        return { f, m: st.mtimeMs };
      } catch {
        return { f, m: 0 };
      }
    }),
  );
  rows.sort((a, b) => b.m - a.m);
  return rows.length ? rows.map((r) => `${tilde(r.f)}  ${r.m ? fmtTime(r.m) : ""}`).join("\n") : "没找到。";
}

async function searchFiles({ query, by = "any", dir }: { query: string; by?: "name" | "any"; dir?: string }) {
  const where = resolvePath(dir || "~");
  return mdfind(by === "name" ? ["-onlyin", where, "-name", query] : ["-onlyin", where, query], 40);
}

async function recentFiles({ days = 1, dir }: { days?: number; dir?: string }) {
  const where = resolvePath(dir || "~");
  const q = `kMDItemFSContentChangeDate >= $time.today(-${Math.max(0, Math.min(90, Math.round(days)))}) && kMDItemContentTypeTree != "public.folder"`;
  return mdfind(["-onlyin", where, q], 50);
}

async function systemInfo() {
  const safe = async (cmd: string, args: string[]) => {
    try {
      return (await run(cmd, args, { timeout: 5000 })).stdout.trim();
    } catch {
      return "（获取失败）";
    }
  };
  const [ver, disk, batt, up, apps] = await Promise.all([
    safe("/usr/bin/sw_vers", []),
    safe("/bin/df", ["-h", "/System/Volumes/Data"]),
    safe("/usr/bin/pmset", ["-g", "batt"]),
    safe("/usr/bin/uptime", []),
    safe("/bin/ps", ["-axco", "pcpu,rss,comm", "-r"]),
  ]);
  const top = apps.split("\n").slice(0, 11).join("\n");
  return `【系统】\n${ver}\n内存 ${fmtSize(os.totalmem())}，空闲 ${fmtSize(os.freemem())}\n\n【磁盘】\n${disk}\n\n【电池】\n${batt}\n\n【运行时长/负载】\n${up}\n\n【CPU 占用最高的进程】（%CPU / 内存KB / 名称）\n${top}`;
}

const fmtWhen = (ms: number) =>
  new Date(ms).toLocaleString("zh-CN", { month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

function fmtLeft(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.round((s % 86400) / 3600)} 小时`;
}

async function setReminder({ text, delay_seconds, at }: { text?: string; delay_seconds?: number; at?: string }) {
  const now = Date.now();
  const content = (text ?? "").trim();
  if (!content) return "没给提醒内容，再调一次，把 text 写上。";
  let when: number | null = null;
  if (at && String(at).trim()) {
    when = resolveWhen(String(at), now);
    if (when === null) return `看不懂这个时间「${at}」。请写成 2025-11-01 21:30 这样，或者改用 delay_seconds。`;
  } else if (typeof delay_seconds === "number" && Number.isFinite(delay_seconds)) {
    when = now + Math.round(delay_seconds * 1000);
  }
  if (when === null) return "需要 delay_seconds 或 at 其中一个。";
  if (when <= now + 1000)
    return `这个时间（${fmtWhen(when)}）已经过去了，现在是 ${fmtWhen(now)}。不能设过去的提醒，请和对方确认一个将来的时间。`;
  const r = addReminder(content, when);
  return `已设好提醒：${fmtWhen(r.at)}（${fmtLeft(r.at - now)}后）「${r.text}」，编号 ${r.id}。`;
}

async function listReminders() {
  const list = pendingReminders();
  if (!list.length) return "现在没有待触发的提醒。";
  const now = Date.now();
  return (
    `待触发的提醒（${list.length} 个）：\n` +
    list.map((r) => `#${r.id} · ${fmtWhen(r.at)} · ${fmtLeft(r.at - now)}后 · ${r.text}`).join("\n")
  );
}

async function cancelReminderTool({ id }: { id?: number }) {
  const rid = Number(id);
  if (!Number.isFinite(rid)) return "需要提醒的编号 id（用 list_reminders 能看到）。";
  const r = cancelReminder(rid);
  return r ? `已取消 #${r.id}「${r.text}」（${fmtWhen(r.at)}）。` : `没有编号 ${rid} 的待触发提醒，可以先 list_reminders 看看。`;
}

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出电脑上某个文件夹里的内容（按修改时间排序）。路径可以用 ~ 表示用户主目录，如 ~/Downloads、~/Desktop、~/Documents。",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取电脑上一个文件的文字内容。支持纯文本/代码/Markdown、Word、RTF、网页、PDF。长文件一次读 2 万字，用 offset 继续。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "number" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "用 Spotlight 在电脑上找文件。by=name 只按文件名找；by=any 同时搜文件名和文件内容。dir 可限定目录，默认主目录。",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, by: { type: "string", enum: ["name", "any"] }, dir: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_files",
      description: "列出最近 N 天改过的文件（days=0 表示今天），可用 dir 限定目录。适合回答「我今天/最近在忙什么」。",
      parameters: { type: "object", properties: { days: { type: "number" }, dir: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "system_info",
      description: "查看电脑状态：系统版本、内存、磁盘空间、电池、开机时长、占 CPU 最多的进程。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description:
        "给对方设一个定时提醒，到点在聊天界面里弹出来，同时发系统通知。delay_seconds 和 at 二选一：delay_seconds 是相对现在多少秒后（1 分钟后=60，两小时=7200）；at 是绝对时间，用本地时间写，如 2025-11-01 21:30。时间必须是将来，过去的时间会报错。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "提醒内容，简短，如「喝水」「开会」" },
          delay_seconds: { type: "number", description: "多少秒之后提醒" },
          at: { type: "string", description: "绝对时间，如 2025-11-01 21:30" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "列出还没触发的提醒（编号、时间、还有多久、内容）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "取消一个还没触发的提醒，需要编号 id（list_reminders 里能看到）。",
      parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "repair_self",
      description:
        "修改你自己（这个聊天应用）的代码：对方让你加功能、修 bug、改样式、改你的说话方式或行为时用。把对方的要求连同必要的上下文写清楚，交给后台的编码助手去改；改完会自动检查、重启，失败自动退回。要几分钟。",
      parameters: { type: "object", properties: { request: { type: "string", description: "要改什么，写具体" } }, required: ["request"] },
    },
  },
];

const IMPL: Record<string, (a: never) => Promise<string>> = {
  repair_self: async ({ request }: { request: string }) => startRepair(request),
  set_reminder: setReminder as (a: never) => Promise<string>,
  list_reminders: listReminders,
  cancel_reminder: cancelReminderTool as (a: never) => Promise<string>,
  list_dir: listDir,
  read_file: readFile,
  search_files: searchFiles,
  recent_files: recentFiles,
  system_info: systemInfo,
};

/** 给前端显示「正在做什么」的一句话 */
export function toolLabel(name: string, args: Record<string, unknown>) {
  const p = String(args.path ?? args.dir ?? "");
  switch (name) {
    case "list_dir":
      return `看看 ${p}`;
    case "read_file":
      return `读 ${path.basename(p)}`;
    case "search_files":
      return `找「${args.query}」`;
    case "recent_files":
      return "看最近改过的文件";
    case "system_info":
      return "看看电脑状态";
    case "set_reminder":
      return `设个提醒：${String(args.text ?? "")}`;
    case "list_reminders":
      return "看看有哪些提醒";
    case "cancel_reminder":
      return `取消提醒 #${String(args.id ?? "")}`;
    case "repair_self":
      return "开始改自己的代码";
    default:
      return name;
  }
}

export async function runTool(name: string, rawArgs: string): Promise<string> {
  const fn = IMPL[name];
  if (!fn) return `没有这个工具：${name}`;
  try {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    const out = await fn(args as never);
    return out.length > 30_000 ? out.slice(0, 30_000) + "\n……（太长，已截断）" : out;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EPERM" || err.code === "EACCES")
      return "没有权限读这里（macOS 隐私保护）。需要在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里给 node 打开。";
    if (err.code === "ENOENT") return "这个路径不存在。";
    return `出错了：${err.message}`;
  }
}
