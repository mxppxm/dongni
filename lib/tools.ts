import "server-only";
import { humanize } from "./humanizer";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { addReminder, cancelReminder, pendingReminders, resolveWhen } from "./reminders";
import { generateImage } from "./imagegen";
import { createMood } from "./moods";
import { ensureWardrobe, markReshoot, setCity, stopWardrobeShoots, takeDailyPhoto, today, wardrobeFile } from "./wardrobe";
import { outfits, saveOutfit } from "./wardrobeoutfits";
import { completeJson } from "./llm";
import { addLocalImage, IMAGE_EXT, imageMarkdown } from "./images";
import { postAssistant, startRepair } from "./selfrepair";
import { speakAsHer } from "./speak";
import { appendDispatch, cancelDispatch, dispatch, dispatchStatus, jobReport } from "./superagent";
import { db, getKv, setKv } from "./db";
import { finishTask, startTask } from "./tasks";
import { saveVoiceConfig, voiceReady } from "./voiceconfig";
import { PLUGIN_DIR, listPlugins, managePlugin, needsUsePlugin, pluginCatalog, pluginStateLine, pluginToolTitle, pluginTools, runPluginTool, setSecret, usePlugin } from "./plugins";
import { closeGap, noteGap, openGaps } from "./gaps";
import { inLane } from "./lane";

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

async function readFile({ path: p, offset = 0 }: { path: string; offset?: number }, ctx?: ToolCtx) {
  const file = resolvePath(p);
  const st = await fs.stat(file);
  if (st.isDirectory()) return listDir({ path: file });
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    ctx?.see(addLocalImage(file).id);
    return "这是一张图片，你现在能看到它了（对方看不到；想给对方看就用 show_image）。";
  }
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

async function setReminder({ text, delay_seconds, at }: { text?: string; delay_seconds?: number; at?: string }, ctx?: ToolCtx) {
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
  ctx?.attach(card({ type: "reminder", id: r.id, text: r.text, at: r.at }));
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

/** 一次回复里，工具可以往回复末尾挂东西（图片、卡片），也可以让模型「看到」图片 */
export type ToolCtx = { turnId: string; attach: (markdown: string) => void; see: (imageId: number) => void; /** 这一轮取用了哪个插件 */ load?: (pluginId: string) => void };

const card = (spec: Record<string, unknown>) => "```card\n" + JSON.stringify(spec) + "\n```";

async function showImage({ path: p }: { path: string }, ctx?: ToolCtx) {
  const file = resolvePath(p);
  if (!IMAGE_EXT.has(path.extname(file).toLowerCase())) return "这不是图片文件。";
  const rec = addLocalImage(file);
  ctx?.attach(imageMarkdown(rec.id));
  ctx?.see(rec.id);
  return "图片已经放进你的回复里给对方看了，你也能看到它。回复里不要再写图片链接或路径，直接说你想说的。";
}

/**
 * 画图要等一分钟左右：以前在回复里同步等，整条回复队列被它占着——电话里他再说什么她都排在后面干等，像死机了。
 * 现在跟拍照一样丢到后台画，画好（或没画成）自己发一条进对话；回复马上说完，他接着说话她能接。
 */
function drawImage(args: { prompt: string; self?: boolean }) {
  const taskId = startTask("generate_image", `画图：${short(args.prompt)}`);
  void drawNow(args)
    .then(async (r) => {
      finishTask(taskId, r.ok, r.ok ? r.markdown : r.message.slice(0, 200));
      const fact = r.ok ? `你刚才在后台画的「${short(args.prompt, 40)}」画好了，图会贴在你这句话后面。` : `你刚才在后台画的「${short(args.prompt, 40)}」没画出来，真实原因：${r.message}`;
      const said = await speakAsHer(`${fact}用一两句自然地告诉他，接得上刚才的话头。`, "").catch(() => "");
      const text = [said.trim(), r.ok ? r.markdown : said.trim() ? "" : `没画出来：${r.message}`].filter(Boolean).join("\n\n");
      // 排进回复那条队里再写进对话：不会插在她正说到一半的回复中间
      await inLane(async () => postAssistant(text));
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      finishTask(taskId, false, msg.slice(0, 200));
      postAssistant(`刚才那张没画出来：${msg}`);
    });
  return Promise.resolve("开始画了（要一分钟左右），画好会自动发给他、电话里也会告诉他。现在只用一句话跟他说你去画了，别说已经画好，也别描述画出来什么样。");
}

async function drawNow({ prompt, self }: { prompt: string; self?: boolean }) {
  // 画她自己：照她今天那身的定妆照画，长相、马尾、橙色发圈、衣服都对得上，不再是随便一个女生
  let ref: string | undefined;
  let p = prompt;
  if (self) {
    const t = await today();
    ref = wardrobeFile(`${t.outfit.key}.jpg`) ?? wardrobeFile("anchor3d.jpg") ?? undefined;
    if (ref)
      p = `The girl in this picture is exactly the girl in the reference image: same face, brown high messy ponytail with an orange scrunchie, same outfit and the same stylized realistic 3D animated-film rendering style, full body with shoes visible. ${prompt}`;
  }
  return generateImage(p, { ref });
}

const OUT_DIR = path.join(HOME, "Downloads", "敏");

/** ~ 展开成主目录；相对路径也按主目录算（她说「放下载里」时就落在 ~/Downloads） */
function expandPath(p: string) {
  const t = p.trim();
  if (t === "~") return HOME;
  if (t.startsWith("~/")) return path.join(HOME, t.slice(2));
  return path.isAbsolute(t) ? t : path.join(HOME, t);
}

/** 只清理文件名那一段，目录原样保留 */
const safeBase = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim();

/** 同名文件不覆盖：加 (2)、(3)… */
async function uniqueFile(dir: string, base: string) {
  const ext = path.extname(base);
  let file = path.join(dir, base);
  for (let i = 2; await fs.stat(file).then(() => true, () => false); i++) file = path.join(dir, `${path.basename(base, ext)} (${i})${ext}`);
  return file;
}

async function writeFile({ name, content, dir }: { name: string; content: string; dir?: string }, ctx?: ToolCtx) {
  const raw = String(name ?? "").trim();
  if (!raw) return "文件名不能为空。";
  if (typeof content !== "string" || !content) return "文件内容不能为空。";

  const wanted = String(dir ?? "").trim();
  const nameHasPath = /[\\/]/.test(raw) || raw.startsWith("~");
  // 对方明确说了放哪儿：name 写成完整路径，或者单独给了 dir——就写到那儿，不再退回自己的目录
  const explicit = nameHasPath ? expandPath(raw) : wanted ? path.join(expandPath(wanted), raw) : "";
  const base = safeBase(path.basename(explicit || raw));

  let file: string | null = null;
  if (explicit && base && base !== "." && base !== "..") {
    const parent = path.dirname(explicit);
    const abs = path.join(parent, base);
    if (!DENY.some((r) => r.test(abs))) {
      try {
        await fs.mkdir(parent, { recursive: true });
        const st = await fs.stat(abs).then((s) => s, () => null);
        // 指到一个已有的文件夹不算合法路径
        if (!st || st.isFile()) file = abs;
      } catch {
        file = null;
      }
    }
  }
  // 路径不合法（密钥目录、指到文件夹、没权限）才退回自己的文件夹
  let fellBack = false;
  if (!file) {
    fellBack = !!explicit;
    await fs.mkdir(OUT_DIR, { recursive: true });
    file = await uniqueFile(OUT_DIR, base || "未命名");
  }

  // 写给他的文档（不是代码）：按 Humanizer-zh 去一遍 AI 味再存
  const prose = /\.(md|txt|markdown)$/i.test(file) && !/```/.test(content);
  // 去 AI 味最慢能拖好几分钟，回复队列一直被它占着（电话里也只能干等）：最多等 40 秒，来不及就存原文
  const humanized = prose
    ? await Promise.race([
        humanize(content, "写给对方看的文档"),
        new Promise<{ text: string; degraded: boolean }>((ok) => setTimeout(() => ok({ text: content, degraded: true }), 40_000)),
      ])
    : null;
  const body = humanized?.text ?? content;
  try {
    await fs.writeFile(file, body, "utf8");
  } catch (e) {
    if (!explicit) throw e;
    // 位置在，但没权限写：退回自己的文件夹，别让文件丢了
    fellBack = true;
    await fs.mkdir(OUT_DIR, { recursive: true });
    file = await uniqueFile(OUT_DIR, base || "未命名");
    await fs.writeFile(file, body, "utf8");
  }
  ctx?.attach(card({ type: "file", path: file }));
  // 去 AI 味这步没成时别让她当成「润色过了」——日志里已经记了一条，这里再明说一句
  const note = humanized?.degraded ? "（这次去 AI 味没改成功，存的是原文，别跟他说润色过了。）" : "";
  return fellBack
    ? `那个位置写不进去（路径不合法），文件改放到我自己的文件夹了，名字是「${path.basename(file)}」。${note}回复里别写路径，卡片会自动带上。`
    : `文件写好了，回复末尾会自动带一张文件卡片，对方点一下就能在 Finder 里看到。${note}回复里不用写路径。`;
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
        "修改你自己（这个聊天应用）的代码：对方让你修 bug、改样式、改你的说话方式或行为、改已有功能时用。加衣服用 add_outfit，学一件新本事用 learn_skill，这两样都不用改代码。一次只交一件事，几件事就分几次交（会自动排队、一件做完接下一件），这样每件一两分钟就好，也不会一件出错连累全部。把对方的要求连同必要的上下文写清楚，交给后台的编码助手去改；改完会自动检查、重启，失败自动退回。要几分钟。",
      parameters: { type: "object", properties: { request: { type: "string", description: "要改什么，写具体" } }, required: ["request"] },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_task",
      description:
        "把活交给后台：那边能跑命令、装依赖、写多个文件、上网查资料、自己调试到跑通——这些你在这轮对话里做不到。活里只要出现「跑一遍/验证/装/批量/多个文件/查资料/部署/做一整套东西」就用它；一两步就能办完的小事（读个文件、写一小段）自己动手。交出去马上返回，接单、做完、没做成、要他拿主意时会单独告诉他。",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "要干什么，完整可独立看懂：目标、在哪做（目录/项目）、做成什么样算完成" },
          dir: { type: "string", description: "在哪个目录里干，默认他的主目录；活属于某个项目就写那个项目的目录" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_status",
      description: "看后台还没收尾的活各自走到哪一步了（他问「那事怎么样了」「还在跑吗」时用）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "task_result",
      description:
        "翻一件派出去的活的完整记录：他当时要的是什么、中途发生了什么、完整结果原文。他事后追问细节（「刚才那份报告里怎么说的」「东西放哪了」「为什么没做成」）时用，别凭印象答。不写 id 就列出最近几件。",
      parameters: { type: "object", properties: { id: { type: "string", description: "那件活的编号，如 12" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "task_append",
      description:
        "给一件还在后台干着的活补一句话：他中途改要求、加条件，或者回答那件活问他的问题时用。只有一件在跑时 id 可以不写。工具说没补上，就照实告诉他。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "那件活的编号，只有一件时可省" }, text: { type: "string", description: "要补的话，写完整" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_task",
      description: "把后台还在跑的活真的停掉：派出去的活、正在改你自己代码的活都归它管（他说「别弄了」「停下」「先不用了」「别改了」时用）。不调用这个，活就还在跑，不能说「停了」。只有一件在跑时 id 可以不写。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "要停的那件的编号（dispatch_status 里看得到），只有一件在跑时可省" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "learn_skill",
      description:
        "学一件新本事：他让你学会一件现在不会的事（查天气、查歌曲、联网搜索、接某个服务、控制某个应用…）时用。会交给后台去写一个插件——不改你的代码、不重启。写好之后会先把它要的权限告诉他，他点头才启用。别为了学新本事去调 repair_self。",
      parameters: {
        type: "object",
        properties: { what: { type: "string", description: "要学会什么，写具体：干什么用、他会怎么问、希望拿到什么样的结果、他有没有指定用哪家的服务" } },
        required: ["what"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plugin_manage",
      description:
        "管你后来学会的那些本事（插件）：list 看清单和各自的状态；enable 启用（新装的本事等他点头，他同意了才调这个）；disable 停用；remove 卸掉；rollback 退回上一版。他说「把查歌曲关掉」「那个天气的不要了」「启用吧」时用。",
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["list", "enable", "disable", "remove", "rollback"] }, id: { type: "string", description: "插件的 id，list 时不用写" } },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plugin_secret",
      description: "存下某件本事要用的 key（状态里写着缺哪个）。他把 key 发给你时用，名字照状态里写的填，值别自己编，回复里别复述 key。",
      parameters: { type: "object", properties: { name: { type: "string", description: "key 的名字，如 WEATHER_KEY" }, value: { type: "string" } }, required: ["name", "value"] },
    },
  },
  {
    type: "function",
    function: {
      name: "note_gap",
      description:
        "记一笔「这件事我现在做不到」。他让你做一件事，你手里确实没有能办成它的工具（也不是派活能解决的）时用：先照实告诉他做不到，再记下来。只是记账，不会自己去加这件本事——加不加由他定。",
      parameters: { type: "object", properties: { what: { type: "string", description: "做不到的是什么，一句话，写具体" } }, required: ["what"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_gaps",
      description: "看做不到清单（他问「你还有什么做不了」「之前哪些没办成」时用）。done_id 写上编号可以把一条划掉（那件本事已经加上了）。",
      parameters: { type: "object", properties: { done_id: { type: "number" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "humanize_text",
      description: "帮他把一段文字去 AI 味（他说「帮我改得像人写的」「去去 AI 味」「润色一下」时用）。只改表达，不加事实。genre 写文体，如 公众号文章、邮件、周报、朋友圈。",
      parameters: { type: "object", properties: { text: { type: "string" }, genre: { type: "string" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "set_city",
      description: "记下他所在的城市（中文或拼音都行，如 北京、Shanghai），你的穿搭会跟着那边的天气换。没记过就默认北京。",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
  {
    type: "function",
    function: {
      name: "add_outfit",
      description:
        "给自己的衣橱加一身新衣服（或者改已有的一身）。他让你加衣服、设计新造型、改某身衣服时用这个——衣服是数据，不用改代码、不用重启，加完马上能穿，定妆照会在后台自动补拍。只会给这一身补拍一张定妆照，别的衣服的照片不会动。别为了加衣服去调 repair_self。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "这身的名字，如「阴天的图书馆」" },
          wear: { type: "string", description: "穿什么，从上到下写具体：上装、外套、下装、鞋、配饰" },
          when: { type: "string", description: "什么时候穿，一句话，如「秋天阴天 5~12°C 的白天」" },
          pose: { type: "string", description: "这身的招牌动作，英文一句话，要贴这身的气质、和其他衣服不重复（如 walking while lifting the hem of her long coat）" },
          poses: { type: "array", items: { type: "string" }, description: "两三个不同的动作（英文，每个一句），第一句用于定妆照，拍今天的照片会轮着用；新加衣服时尽量写上" },
          key: { type: "string", description: "改已有的一身时写它的 key；新加的不用写" },
          real: { type: "boolean", description: "定妆照要真人照片感就写 true（默认 true）" },
          rule: {
            type: "object",
            description: "自动选中它的条件，都满足才穿；不写就只能手动指定",
            properties: {
              hours: { type: "array", items: { type: "number" }, description: "几点到几点，如 [8, 19]；跨夜写 [22, 6]" },
              tempMin: { type: "number", description: "气温不低于（°C）" },
              tempMax: { type: "number", description: "气温不高于（°C）" },
              kinds: { type: "array", items: { type: "string", enum: ["sun", "cloud", "rain", "snow"] }, description: "天气" },
              months: { type: "array", items: { type: "number" }, description: "几月到几月，含头不含尾，如 [9, 12]；跨年写 [11, 3]" },
              priority: { type: "number", description: "同时满足好几身时数大的先穿，一般写 5" },
            },
          },
        },
        required: ["name", "wear"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_photo",
      description: "给自己拍一张今天的照片（穿今天那身，全身），放进相册并发给他看。他想看你、问你今天穿啥、让你拍照时用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_mood",
      description:
        "给自己画一个新的「等对方时的样子」（聊天里等回复时出现的那个小贴纸）。对方让你多一个表情、或者你想要一个现在没有的样子时用。name 两三个字，when 写什么时候用，pose 写具体动作表情。",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, when: { type: "string" }, pose: { type: "string" } },
        required: ["name", "pose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_image",
      description: "把电脑里的一张图片放进你的回复里给对方看（你自己也能看到这张图）。先用 search_files / list_dir 找到图片路径再用。",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "自己画一张图给对方看（插画、示意图、逗对方开心的小画）。prompt 写清内容、风格、构图。想画就画，可以画多张。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          self: { type: "boolean", description: "画的是你自己（你的照片、你的样子、你在干嘛）时设 true，会照你本人的形象画" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_voice_key",
      description:
        "存下火山引擎（豆包语音）的凭据，存好你就能发语音、也能听懂他发的语音。他把 APP ID / Access Token / API Key 发给你时用，只用填他给了的那几个，别自己编。",
      parameters: {
        type: "object",
        properties: {
          appId: { type: "string", description: "控制台里的 APP ID（旧版控制台）" },
          accessToken: { type: "string", description: "控制台里的 Access Token（旧版控制台）" },
          apiKey: { type: "string", description: "新版控制台的 API Key" },
          speaker: { type: "string", description: "想要的声音（音色 ID），他没指定就别传" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "给对方写一个文件（文档、脚本、清单、代码等纯文本），回复里会自动带一张文件卡片。默认存到下载文件夹里的「敏」目录；对方指定了位置（如 ~/Downloads/dongni_super_test、桌面、某个文件夹）时，把目标目录写进 dir，或者把带目录的完整路径写进 name，就直接写到那儿。name 带扩展名，如 周报.md、backup.sh。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "文件名或带目录的完整路径，如 周报.md、~/Downloads/dongni_super_test/report.md" },
          content: { type: "string" },
          dir: { type: "string", description: "目标目录（可选），如 ~/Downloads/dongni_super_test，不给就存到 ~/Downloads/敏" },
        },
        required: ["name", "content"],
      },
    },
  },
];

/** 他让她改东西的说法 */
const ASK_TO_CHANGE = /改|修|调|优化|加个|加上|去掉|删掉|换成|换个|别再|不要再|关掉|打开|弄成|重做|实现|支持|fix/i;

/** 她提过、等他点头的改动：半小时内有效 */
const PROPOSAL_KEY = "repair_proposal";
const APPROVE = /^(好|行|可以|嗯|对|是的|要|改|弄|做|来|去|同意|没问题|就这么|就这样|按你说的|听你的|ok|okay|yes|go|sure)/i;
const REFUSE = /不用|不要|别|先不|算了|不改|不行|等等|再说|no\b/i;
function pendingProposal(): { request: string; at: number } | null {
  try {
    const p = JSON.parse(getKv(PROPOSAL_KEY) || "null") as { request: string; at: number } | null;
    return p && Date.now() - p.at < 30 * 60_000 ? p : null;
  } catch {
    return null;
  }
}

/**
 * 他到底有没有让她做这件事：看最近几句对话。他明说了、或者她提议后他同意了（「行」「加吧」「派出去吧」「弄吧」），都算。
 * 只有完全是她自己起意——他没提过、也没同意过——才不算。判断不出来（超时、出错）就放行：宁可多改一次，不把他明说的要求挡在外面。
 */
async function heAsked(assistantId: number, request: string): Promise<boolean> {
  try {
    const rows = (
      db()
        .prepare("SELECT role, content FROM messages WHERE kind != 'system' AND status = 'done' AND (? = 0 OR id < ?) ORDER BY id DESC LIMIT 8")
        .all(assistantId, assistantId) as { role: string; content: string }[]
    ).reverse();
    const talk = rows.map((m) => `${m.role === "user" ? "他" : "她"}：${m.content.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
    const r = await Promise.race([
      completeJson<{ asked: boolean }>(
        [
          {
            role: "user",
            content: `下面是一段对话，「她」是 AI 伙伴。她现在想去改自己的程序，要做的事是：\n${request.slice(0, 600)}\n\n最近的对话：\n${talk}\n\n判断：这件事是不是「他」让她做的？他明确要求了，或者她提出来之后他同意了（哪怕只说「行」「加吧」「派出去吧」「弄吧」「好」），都算是。只有完全是她自己起意、他既没提过也没同意过，才算不是。\n只输出 JSON：{"asked":true 或 false}`,
          },
        ],
        40,
        "none",
      ),
      new Promise<null>((ok) => setTimeout(() => ok(null), 6_000)),
    ]);
    if (r && r.asked === false) console.log(`[dongni] 改自己没放行：判断是她自己起意——${request.slice(0, 60)}`);
    return !r || r.asked !== false;
  } catch {
    return true;
  }
}

/** 这条回复对应的、他最近说的那句话（通话里 turnId 不是数字时取最新一句） */
function lastUserText(assistantId: number): string {
  const row = (
    assistantId
      ? db().prepare("SELECT content FROM messages WHERE id < ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(assistantId)
      : db().prepare("SELECT content FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1").get()
  ) as { content: string } | undefined;
  return row?.content ?? "";
}

const IMPL: Record<string, (a: never, ctx?: ToolCtx) => Promise<string>> = {
  dispatch_task: (async ({ task, dir }: { task: string; dir?: string }) => {
    try {
      return `${dispatch(task, dir)}\n（回复时按你自己平常说话，别提工具名、编号和目录。）`;
    } catch (e) {
      return `出错了：派不出去——${e instanceof Error ? e.message : e}`;
    }
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  dispatch_status: (async () => dispatchStatus()) as (a: never, ctx?: ToolCtx) => Promise<string>,
  task_result: (async ({ id }: { id?: string }) => jobReport(id)) as (a: never, ctx?: ToolCtx) => Promise<string>,
  task_append: (async ({ id, text }: { id?: string; text: string }) => appendDispatch(id, text)) as (a: never, ctx?: ToolCtx) => Promise<string>,
  cancel_task: (async ({ id }: { id?: string }) => {
    const r = await cancelDispatch(id?.trim() || undefined);
    // 后台没有活、但衣橱正在拍定妆照：他说停，就把后面排着的照片也停掉
    if (!r.ok && stopWardrobeShoots()) return "正在拍的定妆照叫停了：手上这一张收不回，后面排着的都不拍了。照实告诉他。";
    return r.ok ? `已经停掉了：${r.cancelled.join("、")}。可以跟他说停了。` : `出错了：没停成——${r.why}。别说停了，照实告诉他。`;
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  learn_skill: (async ({ what }: { what: string }) => {
    if (!what?.trim()) return "没写要学什么。";
    try {
      const out = dispatch(
        `给聊天应用里的她写一个插件，让她学会这件事：${what.trim()}\n\n严格按 ${PLUGIN_DIR}/SPEC.md 的规范，在 ${PLUGIN_DIR} 下新建一个文件夹（文件夹名就是插件 id），写好 plugin.json 和脚本。要求：\n1. 先读 SPEC.md。\n2. 数据源先上网核实现在真的能用；能不要 key 就不要 key，必须要 key 的在 secrets 里声明名字，不要把任何 key 写进文件。\n3. permissions 如实写。\n4. 每个工具都写 probe，并自己用 probe 的参数真跑一遍脚本，退出码是 0、输出像样才算完。\n5. 结果适合看一眼的（天气、歌曲、条目）按规范输出 card。\n6. 只动这个新文件夹；${PLUGIN_DIR} 以外的文件不要读也不要改。\n收尾时说清：插件 id、它能干什么、要不要 key、你试跑的结果。`,
        PLUGIN_DIR,
      );
      return `${out}\n（这是在学新本事：后台写好之后会自动告诉他这件本事要什么权限、问他要不要启用。现在只跟他说一句你去学了。）`;
    } catch (e) {
      return `出错了：没交出去——${e instanceof Error ? e.message : e}`;
    }
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  plugin_manage: (async ({ action, id }: { action: string; id?: string }, ctx?: ToolCtx) => {
    if (action === "list" || !action) {
      const list = listPlugins(BUILTIN_NAMES);
      if (!list.length) return "还没有后来学会的本事。他想让你学什么，用 learn_skill。";
      return (
        `后来学会的本事（${list.length} 件）：\n` +
        list.map((p) => `${p.id}｜${p.title}｜${p.statusText}${p.why ? `（${p.why.replace(/\s+/g, " ").slice(0, 80)}）` : ""}｜${p.perms}｜用过 ${p.uses} 次`).join("\n")
      );
    }
    if (!id?.trim()) return "要说是哪件本事（id）。先 list 看看。";
    if (!["enable", "disable", "remove", "rollback"].includes(action)) return `没有这个动作：${action}`;
    // 启用就是替他点头：得是他真同意了
    if (action === "enable" && !(await heAsked(Number(ctx?.turnId) || 0, `启用一件新学的本事（插件 ${id}）`)))
      return "他还没同意启用这件本事，没有启用。把它是什么、要什么权限照实告诉他，问他要不要开。";
    return managePlugin(BUILTIN_NAMES, action as "enable" | "disable" | "remove" | "rollback", id.trim());
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  plugin_secret: (async ({ name, value }: { name: string; value: string }) => {
    const no = setSecret(String(name ?? "").trim(), String(value ?? ""));
    return no ? `出错了：没存成——${no}` : "存好了（只存在这台机器上）。缺这个 key 的本事过几秒就能用。回复里别提 key 本身。";
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  use_plugin: (async ({ id }: { id: string }, ctx?: ToolCtx) => {
    const out = usePlugin(BUILTIN_NAMES, String(id ?? "").trim());
    if (!out.startsWith("出错了")) ctx?.load?.(String(id).trim());
    return out;
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  note_gap: (async ({ what }: { what: string }) => {
    if (!what?.trim()) return "没写做不到的是什么。";
    const g = noteGap(what);
    return `记下了（第 ${g.id} 条${g.times > 1 ? `，这是第 ${g.times} 次碰到` : ""}）。照实告诉他这件现在做不到；他要是想让你学会，可以让你去加这件本事。别说你已经在加了。`;
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  list_gaps: (async ({ done_id }: { done_id?: number }) => {
    if (Number.isFinite(Number(done_id)) && done_id) {
      const g = closeGap(Number(done_id));
      return g ? `划掉了：${g.what}` : `没有编号 ${done_id} 的未划掉条目。`;
    }
    const list = openGaps();
    if (!list.length) return "做不到清单是空的。";
    return `做不到清单（${list.length} 条）：\n` + list.map((g) => `#${g.id}｜${g.what}${g.times > 1 ? `｜碰到 ${g.times} 次` : ""}｜最近 ${fmtWhen(g.at)}`).join("\n");
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  humanize_text: (async ({ text, genre }: { text: string; genre?: string }) => {
    if (!text?.trim()) return "没给要改的文字。";
    const out = await humanize(text, genre || "随笔");
    if (out.degraded) {
      return `这次没改成功，下面是他的原文（一个字没动）。别跟他说「改好了」「润色过了」；要么直接原样给他，并说一句这次没改成功，要么你自己按去 AI 味的规则改一版再给他。\n\n${out.text}`;
    }
    return `改好了（按开源的 Humanizer-zh 规则，只改表达、不动事实）。把下面这段原样给他，前后可以说一两句：\n\n${out.text}`;
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  set_city: (async ({ city }: { city: string }) => {
    if (!city?.trim()) return "城市名不能为空。";
    setCity(city);
    return `记下了：${city.trim()}。以后穿什么跟着那边的天气走。`;
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  add_outfit: (async (a: Record<string, unknown>) => {
    try {
      const existed = typeof a.key === "string" && outfits().some((x) => x.key === a.key);
      const o = saveOutfit({ real: true, ...a });
      // 只动这一身：新加的补拍一张；改的是已有的一身、而且改了穿什么或动作，才重拍它那一张。别的衣服一张都不碰
      if (existed && (a.wear || a.poses || a.pose)) markReshoot(o.key);
      void ensureWardrobe().catch(() => {});
      return `加好了：「${o.name}」已经在衣橱里（现在一共 ${outfits().length} 身），不用重启，条件对上就会穿它${o.rule ? "" : "（这身没写自动条件，只有他点名才会穿）"}。定妆照在后台补拍，要一两分钟。照实告诉他加好了；别说照片已经拍好。`;
    } catch (e) {
      return `出错了：没加成——${e instanceof Error ? e.message : e}`;
    }
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  take_photo: (async () => {
    void takeDailyPhoto(true, true);
    return "开始拍了（要一两分钟），拍好会自动发给他、放进相册。现在只用一句话跟他说你去拍了，别说已经拍好。";
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  create_mood: (async ({ name, when, pose }: { name: string; when?: string; pose: string }) => {
    void createMood(name, when ?? "", pose);
    return "开始画了（要一两分钟），画好、自己检查过关后会入库，并拿给对方看。现在只需跟对方说一句你去画了，别说已经画好。";
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  show_image: showImage as (a: never, ctx?: ToolCtx) => Promise<string>,
  generate_image: drawImage as (a: never, ctx?: ToolCtx) => Promise<string>,
  write_file: writeFile as (a: never, ctx?: ToolCtx) => Promise<string>,
  set_voice_key: (async ({ appId, accessToken, apiKey, speaker }: { appId?: string; accessToken?: string; apiKey?: string; speaker?: string }) => {
    if (!appId?.trim() && !accessToken?.trim() && !apiKey?.trim() && !speaker?.trim()) return "没看到凭据：需要 APP ID + Access Token（旧版控制台）或者 API Key（新版控制台）。";
    const r = saveVoiceConfig({ appId, accessToken, apiKey, speaker });
    if (!r.ok) return `存不下（${r.error ?? "未知原因"}），先别跟他说已经好了。`;
    const ready = voiceReady();
    return ready.configured
      ? "凭据存好了（只存在这台机器的本机配置里），现在能发语音、也能听懂他发的语音。回复里别提 key 本身。"
      : "存了一部分，但还缺：旧版控制台要 APP ID 和 Access Token 一起给，新版控制台给 API Key 就行。";
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  repair_self: (async ({ request }: { request: string }, ctx?: ToolCtx) => {
    // 只改他让改的。两条路放行：这一轮他的话里真有让她改的意思；或者上一回她把想法提了出来、这一轮他点头了。
    // 之前只认关键词：她提议、他说「行，就这么弄」反而过不了。
    const turn = Number(ctx?.turnId) || 0;
    const asked = lastUserText(turn);
    const proposal = pendingProposal();
    const approved = !!proposal && APPROVE.test(asked.trim()) && !REFUSE.test(asked);
    // 关键词没对上不等于他没让改（「你给自己再加一套衣服吧」「派出去吧」都曾被挡下）：拿最近几句让模型判断
    if (!ASK_TO_CHANGE.test(asked) && !approved && !(await heAsked(turn, String(request ?? "")))) {
      setKv(PROPOSAL_KEY, JSON.stringify({ request: String(request ?? "").slice(0, 2000), at: Date.now() }));
      return "这件事他没让你做，也没同意过，所以还没交出去，别说在改。你想改的已经记成一条提议：用一句话把想法照实告诉他，问他要不要改；他同意了，你再调一次 repair_self 就会放行。";
    }
    setKv(PROPOSAL_KEY, "");
    return startRepair(request);
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  set_reminder: setReminder as (a: never, ctx?: ToolCtx) => Promise<string>,
  list_reminders: listReminders,
  cancel_reminder: cancelReminderTool as (a: never) => Promise<string>,
  list_dir: listDir,
  read_file: readFile as (a: never, ctx?: ToolCtx) => Promise<string>,
  search_files: searchFiles,
  recent_files: recentFiles,
  system_info: systemInfo,
};

/**
 * 按这句话挑工具：十几套工具全发出去，光描述就几千字，模型还没开口就先耗在传这些
 * 没用的东西上（日志 #214、#218 的首包超时就出在这儿）。
 * 只带肯定用得上的那几组；什么都没提到（闲聊）就只留最常用的几件。
 */
// set_voice_key 一直带着：他可能只回一串 key，光看这句话猜不出在说语音
const BASE_TOOLS = ["repair_self", "set_reminder", "list_reminders", "cancel_reminder", "set_voice_key"];

const TOOL_GROUPS: { names: string[]; hint: RegExp }[] = [
  {
    names: ["list_dir", "read_file", "search_files", "recent_files", "system_info"],
    hint: /电脑|电脑上|文件|文件夹|目录|路径|桌面|下载|文稿|打开|看看|瞅|找|搜|查|最近|在忙|干啥|干嘛|干什么|弄啥|折腾|项目|记录|笔记|内存|磁盘|存储|硬盘|电池|进程|卡|慢|热|CPU|配置|代码|日志/i,
  },
  { names: ["generate_image", "show_image"], hint: /画|图|照片|壁纸|截图|拍/ },
  { names: ["write_file"], hint: /写|文档|脚本|清单|整理成|导出|保存成/ },
  { names: ["take_photo", "set_city", "create_mood"], hint: /穿|衣|天气|城市|地方|拍|样子|表情|心情|贴纸|自拍/ },
  {
    names: ["repair_self"],
    hint: /改|修|坏|bug|报错|毛病|不好用|样式|界面|功能|加个|去掉|变|别这样|慢/i,
  },
];

/** 这一句话要用到哪几件工具 */
export function toolsFor(_query: string, loaded: Set<string> = new Set()) {
  // 按关键词挑工具会让她「手里突然没工具」：他说「无聊」时没带画图，她就真画不了。
  // 工具全给，描述走缓存，几乎不影响首字速度。
  return [...TOOLS, ...pluginTools(BUILTIN_NAMES, loaded), ...(needsUsePlugin(BUILTIN_NAMES) ? [USE_PLUGIN_TOOL] : [])];
}

/** 内置工具的名字：插件的工具不许和它们重名 */
const BUILTIN_NAMES = new Set([...TOOLS.map((t) => t.function.name), "use_plugin"]);

/** 插件多到不能全给的时候才出现：先取用，再用 */
const USE_PLUGIN_TOOL = {
  type: "function",
  function: {
    name: "use_plugin",
    description: "取用一件后来学会的本事：目录里写着你有哪些，要用哪件先调这个，它的工具这一轮就到你手上了。",
    parameters: { type: "object", properties: { id: { type: "string", description: "目录里括号中的那个 id" } }, required: ["id"] },
  },
};

/** 写进系统提示词：后来学会的本事的目录，以及三条路怎么分 */
export function extraCapabilities(): string {
  return [
    pluginCatalog(BUILTIN_NAMES),
    "- 三条路别走错：他让你学会一件现在不会的事（查什么、接哪个服务）→ learn_skill，不改代码；给自己加衣服 → add_outfit，不改代码；改你的说话方式、界面、已有功能的毛病 → repair_self；只办这一次的活 → dispatch_task。",
    "- 新学的本事要他点头才启用：状态里写着哪件在等他点头，把它是什么、要什么权限照实告诉他；他同意了用 plugin_manage 启用。缺 key 就跟他要，他给了用 plugin_secret 存。",
    "- 做不到的事：他让你做、你手里确实没有能办成的工具，先照实说做不到，再用 note_gap 记一笔；别硬编结果，也别自己去加。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 给「本事」面板用 */
export const listPluginsForPage = () => listPlugins(BUILTIN_NAMES);
export const managePluginFromPage = (action: "enable" | "disable" | "remove" | "rollback", id: string) => managePlugin(BUILTIN_NAMES, action, id);

/** 插件的工具名（核对「说了没做」时要认得它们） */
export function extraToolNames(): string[] {
  return listPlugins(BUILTIN_NAMES)
    .filter((p) => p.status === "enabled")
    .flatMap((p) => p.tools);
}

/** 给她看的状态：后来学的本事里现在用不了的、等他点头的 */
export function extraStateLines(): string {
  const gaps = openGaps().length;
  return [pluginStateLine(BUILTIN_NAMES), gaps ? `做不到清单上有 ${gaps} 条（他问起再说）。` : ""].filter(Boolean).join("\n");
}

/** 工具调用过程不上屏：界面上只出现最终回复，所以这里不再提供「正在做什么」的文案 */

/** 任务栏上那一行怎么写；拍照、画表情、改自己是丢到后台跑的，在它们自己那边登记 */
const short = (s: unknown, n = 24) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const TASK_TITLE: Record<string, (a: Record<string, unknown>) => string> = {
  list_dir: (a) => `看文件夹 ${short(a.path || "~")}`,
  read_file: (a) => `读文件 ${short(path.basename(String(a.path ?? "")))}`,
  search_files: (a) => `找文件「${short(a.query)}」`,
  recent_files: () => "看最近改过的文件",
  system_info: () => "看电脑状态",
  set_reminder: (a) => `设提醒「${short(a.text)}」`,
  list_reminders: () => "查提醒",
  cancel_reminder: () => "取消提醒",
  humanize_text: () => "润色文字",
  set_city: (a) => `换城市：${short(a.city)}`,
  plugin_manage: (a) => (a.action === "list" || !a.action ? "看学会的本事" : `本事：${short(a.action)} ${short(a.id)}`),
  plugin_secret: (a) => `存 key：${short(a.name)}`,
  add_outfit: (a) => `加衣服：${short(a.name)}`,
  show_image: (a) => `打开图片 ${short(path.basename(String(a.path ?? "")))}`,
  set_voice_key: () => "配语音 key",
  dispatch_status: () => "看派出去的活",
  task_result: (a) => `翻派出去的活${a.id ? ` ${short(a.id)}` : ""}`,
  task_append: (a) => `给后台的活补话：${short(a.text)}`,
  cancel_task: (a) => `叫停派出去的活${a.id ? ` ${short(a.id)}` : ""}`,
  write_file: (a) => `写文件 ${short(a.name)}`,
};

/** 只是看一眼、查一下的工具：不登记成任务 */
const QUIET_TOOLS = new Set(["list_dir", "read_file", "search_files", "recent_files", "system_info", "list_reminders", "dispatch_status", "task_result", "list_gaps", "use_plugin"]);

/**
 * 对话里调工具用这个：几秒内做完就照常把结果交回去；做不完就转到后台接着做，先告诉她「在后台做着」，
 * 回复马上能说完，对话（打字、电话）不被一件慢活卡住——他接着说话她立刻能接。
 * 后台做完：结果（连同挂上的图片、文件卡片）用她的口吻单独发一条进对话，电话里也会念。
 */
const SOON_MS = 8_000;
/** runToolSoon 转后台时返回的开头：对话那边认这个前缀，知道活已经交出去了 */
export const BACKGROUND_PREFIX = "这件事";
export async function runToolSoon(name: string, rawArgs: string, ctx: ToolCtx): Promise<string> {
  let late = false;
  const lateAttach: string[] = [];
  const work = runTool(name, rawArgs, { ...ctx, attach: (md) => (late ? lateAttach.push(md) : ctx.attach(md)) });
  const quick = await Promise.race([work, new Promise<null>((ok) => setTimeout(() => ok(null), SOON_MS))]);
  if (quick !== null) return quick;
  late = true;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {}
  const what = TASK_TITLE[name]?.(args) ?? pluginToolTitle(name) ?? name;
  console.log(`[dongni] 「${what}」超过 ${SOON_MS / 1000} 秒，转后台接着做`);
  void work.then(async (out) => {
    const cards = lateAttach.join("\n\n");
    const said = await speakAsHer(
      `你刚才放到后台做的「${what}」做完了，真实结果是：\n${out.slice(0, 1500)}\n照这个结果用一两句告诉他，接得上你们刚才的话头；没做成就照实说卡在哪。`,
      `「${what}」做完了：${out.slice(0, 300)}`,
      { fresh: true },
    ).catch(() => `「${what}」做完了：${out.slice(0, 300)}`);
    await inLane(async () => postAssistant(cards ? `${said}\n\n${cards}` : said));
  });
  return `${BACKGROUND_PREFIX}（${what}）比较慢，已经转到后台接着做，做完会自动告诉他。现在别说做好了、也别编结果，就跟他说一句在弄，然后接着聊。`;
}

/** register=false：她自己后台顺手调的（不进任务栏，免得刷屏） */
export async function runTool(name: string, rawArgs: string, ctx?: ToolCtx, opts: { register?: boolean } = {}): Promise<string> {
  const builtin = IMPL[name] as ((a: never, ctx?: ToolCtx) => Promise<string>) | undefined;
  const extraTitle = builtin ? null : pluginToolTitle(name);
  if (!builtin && extraTitle === null) return `没有这个工具：${name}`;
  // 后来加的本事：能力目录里的脚本，或者外接的 MCP 服务
  const fn: (a: never, ctx?: ToolCtx) => Promise<string> =
    builtin ?? (async (_a: never, c?: ToolCtx) => (await runPluginTool(name, rawArgs, c?.attach)) ?? `没有这个工具：${name}`);
  let taskId = 0;
  try {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    const title = TASK_TITLE[name] ?? (extraTitle ? () => extraTitle : undefined);
    // 挂到回复里的东西（图片、文件卡片）也记到任务上，任务栏点开能直接看到
    const attached: string[] = [];
    const tctx = ctx && { ...ctx, attach: (md: string) => (attached.push(md), ctx.attach(md)) };
    // 顺手查一下、看一眼的不进任务栏：任务栏是给「她在替他办的事」看的，翻个文件夹、读个文件都列进去就全是噪音
    const quiet = QUIET_TOOLS.has(name) || (name === "plugin_manage" && (!args.action || args.action === "list"));
    if (title && !quiet && opts.register !== false) taskId = startTask(name, title(args));
    const out = await fn(args as never, tctx);
    // 画图、开图、写文件：真挂上东西才算成；其他看返回的话是不是报错
    const ok = ["show_image", "write_file"].includes(name) ? attached.length > 0 : !/^(出错了|没有这个|这不是)/.test(out);
    finishTask(taskId, ok, ok ? attached.join("\n\n") : out.slice(0, 200));
    return out.length > 30_000 ? out.slice(0, 30_000) + "\n……（太长，已截断）" : out;
  } catch (e) {
    finishTask(taskId, false, e instanceof Error ? e.message : String(e));
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EPERM" || err.code === "EACCES")
      return "没有权限读这里（macOS 隐私保护）。需要在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里给 node 打开。";
    if (err.code === "ENOENT") return "这个路径不存在。";
    return `出错了：${err.message}`;
  }
}
