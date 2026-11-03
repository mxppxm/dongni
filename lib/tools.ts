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
import { setCity, takeDailyPhoto, today, wardrobeFile } from "./wardrobe";
import { addLocalImage, IMAGE_EXT, imageMarkdown } from "./images";
import { postAssistant, startRepair } from "./selfrepair";
import { speakAsHer } from "./speak";
import { cancelDispatch, dispatch, judge, runningJobs } from "./superagent";
import { finishTask, startTask } from "./tasks";
import { saveVoiceConfig, voiceReady } from "./voiceconfig";

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
export type ToolCtx = { turnId: string; attach: (markdown: string) => void; see: (imageId: number) => void };

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
      postAssistant([said.trim(), r.ok ? r.markdown : said.trim() ? "" : `没画出来：${r.message}`].filter(Boolean).join("\n\n"));
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
        "修改你自己（这个聊天应用）的代码：对方让你加功能、修 bug、改样式、改你的说话方式或行为时用。一次只交一件事，几件事就分几次交（会自动排队、一件做完接下一件），这样每件一两分钟就好，也不会一件出错连累全部。把对方的要求连同必要的上下文写清楚，交给后台的编码助手去改；改完会自动检查、重启，失败自动退回。要几分钟。",
      parameters: { type: "object", properties: { request: { type: "string", description: "要改什么，写具体" } }, required: ["request"] },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_task",
      description:
        "把重活交给后台那个能跑命令的执行器：它能在项目里跑命令、装依赖、写多个文件、自己调试到自己跑通——这些你在这轮对话里做不到。所以活里只要出现「跑一遍/验证/装/批量/多个文件/部署/做一整套东西」，先用它。",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "要干什么，完整可独立看懂：目标、在哪做（目录/项目）、做成什么样算完成" },
          dir: { type: "string", description: "在哪个目录里干，默认他的主目录" },
          force: { type: "boolean", description: "他明确说「一定要派出去」时才写 true" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_status",
      description: "看后台还有几件活在跑（他问「那事怎么样了」「还在跑吗」时用）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_task",
      description: "把派出去、还在跑的活真的停掉（他说「别弄了」「停下」「先不用了」时用）。不调用这个，活就还在跑，不能说「停了」。只有一件在跑时 id 可以不写。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "要停的那件的编号（dispatch_status 里看得到），只有一件在跑时可省" } },
      },
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

const IMPL: Record<string, (a: never, ctx?: ToolCtx) => Promise<string>> = {
  dispatch_task: (async ({ task, dir, force }: { task: string; dir?: string; force?: boolean }) => {
    const j = judge(task, { force });
    const why = j.reasons.length ? j.reasons.join("；") : "没命中任何信号，按闲聊量级算";
    if (j.target !== "super")
      return `这件不用派（判断：${j.level}，分数 ${j.score}；依据：${why}）。${
        j.target === "pi"
          ? "如果是要改你自己，用 repair_self；其他就在这边自己动手做完。"
          : "你自己几秒钟就能办完，别往外交。"
      }回复里别念这段判断，直接给他结果。`;
    try {
      const out = dispatch(task, dir);
      return `${out}\n（判断依据：${why}。回复时按你自己平常说话，别提工具名和目录，就说「我自己上手了，正在弄，弄完告我」这一类意思。）`;
    } catch (e) {
      return `派不出去：${e instanceof Error ? e.message : e}`;
    }
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  dispatch_status: (async () => {
    const jobs = runningJobs();
    if (!jobs.length) return "现在没有跑着的外活，都清空了。";
    return (
      `有 ${jobs.length} 件在跑：\n` +
      jobs
        .map((j) => `${j.id}｜${j.task.slice(0, 50)}｜在 ${j.dir.replace(HOME, "~")}｜已经跑了 ${Math.round((Date.now() - j.since) / 60000)} 分钟`)
        .join("\n")
    );
  }) as (a: never, ctx?: ToolCtx) => Promise<string>,
  cancel_task: (async ({ id }: { id?: string }) => {
    const r = cancelDispatch(id?.trim() || undefined);
    return r.ok ? `已经停掉了：${r.cancelled.join("、")}。可以跟他说停了。` : `出错了：没停成——${r.why}。别说停了，照实告诉他。`;
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
  take_photo: (async () => {
    void takeDailyPhoto(true);
    return "开始拍了：会先在对话里跟他说一声，拍好（要一两分钟）自动发给他、放进相册。现在别说已经拍好。";
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
  repair_self: async ({ request }: { request: string }) => startRepair(request),
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
export function toolsFor(_query: string) {
  // 按关键词挑工具会让她「手里突然没工具」：他说「无聊」时没带画图，她就真画不了。
  // 工具全给，描述走缓存，几乎不影响首字速度。
  return TOOLS;
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
  show_image: (a) => `打开图片 ${short(path.basename(String(a.path ?? "")))}`,
  set_voice_key: () => "配语音 key",
  dispatch_task: (a) => `派活：${short(a.task)}`,
  dispatch_status: () => "看派出去的活",
  cancel_task: (a) => `叫停派出去的活${a.id ? ` ${short(a.id)}` : ""}`,
  write_file: (a) => `写文件 ${short(a.name)}`,
};

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
  const what = TASK_TITLE[name]?.(args) ?? name;
  console.log(`[dongni] 「${what}」超过 ${SOON_MS / 1000} 秒，转后台接着做`);
  void work.then(async (out) => {
    const cards = lateAttach.join("\n\n");
    const said = await speakAsHer(
      `你刚才放到后台做的「${what}」做完了，真实结果是：\n${out.slice(0, 1500)}\n照这个结果用一两句告诉他，接得上你们刚才的话头；没做成就照实说卡在哪。`,
      `「${what}」做完了：${out.slice(0, 300)}`,
      { fresh: true },
    ).catch(() => `「${what}」做完了：${out.slice(0, 300)}`);
    postAssistant(cards ? `${said}\n\n${cards}` : said);
  });
  return `${BACKGROUND_PREFIX}（${what}）比较慢，已经转到后台接着做，做完会自动告诉他。现在别说做好了、也别编结果，就跟他说一句在弄，然后接着聊。`;
}

/** register=false：她自己后台顺手调的（不进任务栏，免得刷屏） */
export async function runTool(name: string, rawArgs: string, ctx?: ToolCtx, opts: { register?: boolean } = {}): Promise<string> {
  const fn = IMPL[name];
  if (!fn) return `没有这个工具：${name}`;
  let taskId = 0;
  try {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    const title = TASK_TITLE[name];
    // 挂到回复里的东西（图片、文件卡片）也记到任务上，任务栏点开能直接看到
    const attached: string[] = [];
    const tctx = ctx && { ...ctx, attach: (md: string) => (attached.push(md), ctx.attach(md)) };
    if (title && opts.register !== false) taskId = startTask(name, title(args));
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
