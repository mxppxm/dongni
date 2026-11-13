import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getKv, setKv } from "./db";
import { inLane } from "./lane";
import { mcpServerError, mcpServerTools, runMcpTool, syncMcpServers } from "./mcp";
import { notify } from "./notify";
import { postAssistant } from "./selfrepair";
import { speakAsHer } from "./speak";

/**
 * 插件：她后来学会的本事。一件本事 = 一个文件夹，装上、停掉、卸掉都不改她的代码、不重启。
 *
 *   ~/.config/dongni/plugins/<id>/plugin.json   清单：叫什么、能干什么、提供哪些工具、要什么权限和 key
 *   ~/.config/dongni/plugins/<id>/…             脚本（什么语言都行），或者清单里写一个 MCP 服务的启动命令
 *
 * 三层里的中间一层：内核（对话、记忆、电话、任务、自改护栏）走源码；本事走这里；衣橱清单这类内容走数据文件。
 *
 * 生命周期：放进目录 → 等他点头（先把它要的权限、key 给他看；没点头之前一行代码都不跑）→ 试跑 → 启用
 *           → 停用 / 卸载 / 退回上一版；连着三次没跑成自动停用并告诉他。
 * 规范写在同目录的 SPEC.md（自动生成），后台的活照着它写插件。
 */
export const PLUGIN_DIR = process.env.DONGNI_PLUGIN_DIR || path.join(os.homedir(), ".config", "dongni", "plugins");
const SECRETS_FILE = path.join(os.homedir(), ".config", "dongni", "secrets.json");
const VERSIONS = path.join(PLUGIN_DIR, ".versions");
const TRASH = path.join(PLUGIN_DIR, ".trash");
const SCAN_TTL = 3_000;
const OUT_MAX = 20_000;
const KEEP_VERSIONS = 3;
const FAIL_LIMIT = 3;
/** 插件工具总数不超过这么多就全给她；再多就只给目录，用到哪个取哪个 */
const DIRECT_TOOLS = 12;

type ToolDef = { name: string; description: string; parameters?: Record<string, unknown>; command: string[]; timeoutMs?: number; probe?: Record<string, unknown> };
type Permissions = { network?: boolean; read?: string[]; write?: string[]; paid?: boolean };
type Manifest = {
  id: string;
  title: string;
  description: string;
  usage?: string;
  tools?: ToolDef[];
  mcp?: { command: string; args?: string[]; env?: Record<string, string> };
  secrets?: string[];
  permissions?: Permissions;
};
type Plugin = Manifest & { dir: string; stamp: number; permsKey: string };
/** 记在库里的那部分：他点没点头、开没开、用了几次、连着坏了几次 */
type Saved = { enabled: boolean; perms: string; fails: number; why: string; uses: number; lastUsedAt: number; announced: number };
type Probe = { stamp: number; state: "running" | "ok" | "failed"; why: string };
export type PluginStatus = "pending" | "disabled" | "needs_key" | "probing" | "failed" | "enabled";

const mem = ((globalThis as unknown as { __dongniPlugins?: { at: number; list: Plugin[]; bad: string[]; probes: Map<string, Probe> } }).__dongniPlugins ??= {
  at: 0,
  list: [],
  bad: [],
  probes: new Map<string, Probe>(),
});

const STATE_KEY = "plugin_state";
function saved(): Record<string, Saved> {
  try {
    return JSON.parse(getKv(STATE_KEY) || "{}") as Record<string, Saved>;
  } catch {
    return {};
  }
}
function patch(id: string, p: Partial<Saved>) {
  const all = saved();
  const base: Saved = all[id] ?? { enabled: false, perms: "", fails: 0, why: "", uses: 0, lastUsedAt: 0, announced: 0 };
  all[id] = { ...base, ...p };
  setKv(STATE_KEY, JSON.stringify(all));
}

function secrets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 存一个插件要用的 key：只落在本机这一个文件里，权限 600 */
export function setSecret(name: string, value: string): string | null {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) return "key 的名字要大写字母开头，只含大写字母、数字、下划线";
  if (!value.trim()) return "key 是空的";
  try {
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
    const tmp = `${SECRETS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...secrets(), [name]: value.trim() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SECRETS_FILE);
    mem.at = 0;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const SPEC = `# 插件规范

给聊天应用里的她加一件新本事：在这个目录下建一个文件夹，放一份 plugin.json 和要跑的脚本。不改她的代码，不重启。
装好之后她会先把这个插件要的权限告诉他，他点头了才启用——在那之前插件里的代码一行都不会被执行。

## plugin.json

\`\`\`json
{
  "id": "weather",
  "title": "查天气",
  "description": "查某个城市现在的天气和未来几天预报。他问天气、要不要带伞、穿什么时用。",
  "usage": "结果里的温度是摄氏度。跟他说的时候挑他关心的那一两项，不用把整张表念一遍。",
  "tools": [
    {
      "name": "get_weather",
      "description": "查一个城市现在的天气和未来三天预报",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string", "description": "城市名，中文或拼音" } },
        "required": ["city"]
      },
      "command": ["python3", "run.py"],
      "timeoutMs": 30000,
      "probe": { "city": "北京" }
    }
  ],
  "secrets": [],
  "permissions": { "network": true, "read": [], "write": [], "paid": false }
}
\`\`\`

- id：文件夹名必须和它一样。小写字母开头，只含小写字母、数字、下划线，2 到 24 个字符。
- title：给他看的短名字。description：这件本事是什么、什么时候用——她只看这句决定用不用。
- usage：可选，给她看的使用说明：结果怎么理解、怎么跟他说。
- tools：一个插件可以带好几个相关的工具。
  - name：小写字母开头，只含小写字母、数字、下划线，3 到 40 个字符，不能和已有工具重名。
  - parameters：JSON Schema，顶层必须是 object。
  - command：要跑的命令，数组。在这个插件自己的文件夹里执行；第一个元素写相对路径时按这个文件夹算。
  - timeoutMs：最长跑多久，默认 60000，最大 300000。
  - probe：一组真实可用的参数。启用前会拿它真跑一次，退出码是 0 才算可用。每个工具都应该写。
- mcp：可选。这件本事已经有现成的 MCP 服务时，不写 tools，写 \`"mcp": { "command": "npx", "args": ["-y", "某个-mcp-server"] }\`，工具由服务自己报。
- secrets：要用到的 key 的名字（大写，如 WEATHER_KEY）。值不写在这里：运行时从环境变量里读同名变量。缺的话她会开口跟他要。
- permissions：如实声明。network 要不要联网；read / write 要读写哪些目录（插件自己的文件夹不用写）；paid 调用会不会花钱。这些会原样给他看。

## 脚本约定

- 参数：一个 JSON 对象，从标准输入读。
- 结果：打到标准输出。可以是纯文本；想让结果显示成一张卡片，就输出一个 JSON 对象：
  \`{"text": "给她看的结果，说清楚查到了什么", "card": {"title": "北京 · 多云", "rows": [["现在", "8°C"], ["明天", "3~11°C 晴"]], "url": "可选的链接"}}\`
- 出错：退出码非 0，原因打到标准错误。她会照实告诉他。
- key：从环境变量读，不要写进脚本和 plugin.json。
- 脚本要能重复跑；不要交互式提问；不要常驻；输出别超过两万字。

## 写完之后

自己用每个工具的 probe 参数跑一遍，确认退出码是 0、输出像样，再收尾。收尾时说清插件叫什么、放在哪、要不要 key。
`;

function ensureSpec() {
  try {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    const file = path.join(PLUGIN_DIR, "SPEC.md");
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== SPEC) fs.writeFileSync(file, SPEC, "utf8");
  } catch {}
}

const NAME = /^[a-z][a-z0-9_]{2,39}$/;
const permsText = (p: Plugin) =>
  [
    p.permissions?.network ? "要联网" : "不联网",
    p.permissions?.read?.length ? `要读 ${p.permissions.read.join("、")}` : "",
    p.permissions?.write?.length ? `要写 ${p.permissions.write.join("、")}` : "",
    p.permissions?.paid ? "调用会花钱" : "",
    p.secrets?.length ? `需要 key：${p.secrets.join("、")}` : "",
    p.mcp ? "会起一个常驻的外部服务" : "",
  ]
    .filter(Boolean)
    .join("，");

function scan(taken: Set<string>): Plugin[] {
  if (Date.now() - mem.at < SCAN_TTL) return mem.list;
  mem.at = Date.now();
  ensureSpec();
  const list: Plugin[] = [];
  const bad: string[] = [];
  const names = new Set(taken);
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {}
  for (const folder of folders.sort()) {
    const dir = path.join(PLUGIN_DIR, folder);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8")) as Manifest;
      if (!/^[a-z][a-z0-9_]{1,23}$/.test(String(m.id)) || m.id !== folder) throw new Error("id 不合规范，或者和文件夹名不一样");
      if (!m.title?.trim() || !m.description?.trim()) throw new Error("缺 title 或 description");
      const tools = m.tools ?? [];
      if (!tools.length && !m.mcp) throw new Error("既没有 tools 也没有 mcp");
      for (const t of tools) {
        if (!NAME.test(String(t.name))) throw new Error(`工具名不合规范：${t.name}`);
        if (names.has(t.name)) throw new Error(`工具名和已有的重名：${t.name}`);
        if (!t.description?.trim()) throw new Error(`工具 ${t.name} 缺 description`);
        if (!Array.isArray(t.command) || !t.command.length || t.command.some((x) => typeof x !== "string")) throw new Error(`工具 ${t.name} 的 command 要写成字符串数组`);
        if (t.parameters && (t.parameters as { type?: string }).type !== "object") throw new Error(`工具 ${t.name} 的 parameters 顶层必须是 object`);
      }
      if (m.mcp && typeof m.mcp.command !== "string") throw new Error("mcp.command 要写成字符串");
      for (const s of m.secrets ?? []) if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(s)) throw new Error(`key 的名字不合规范：${s}`);
      tools.forEach((t) => names.add(t.name));
      const stamp = Math.max(...fs.readdirSync(dir).map((n) => fs.statSync(path.join(dir, n)).mtimeMs));
      // 权限、key、要跑的命令变了才需要他重新点头；只改脚本内容不用
      const permsKey = JSON.stringify([m.permissions ?? {}, m.secrets ?? [], tools.map((t) => t.command), m.mcp ?? null]);
      list.push({ ...m, tools, dir, stamp, permsKey });
    } catch (e) {
      bad.push(`${folder}：${e instanceof Error ? e.message : e}`);
    }
  }
  mem.list = list;
  mem.bad = bad;
  const st = saved();
  for (const p of list) {
    const s = st[p.id];
    if (!s || s.perms !== p.permsKey) announce(p, s);
    else if (s.enabled) verify(p);
  }
  // 启用着的 MCP 型插件：服务跟着起；停用、卸载的跟着停
  syncMcpServers(
    list
      .filter((p) => p.mcp && statusOf(p) !== "pending" && statusOf(p) !== "disabled" && statusOf(p) !== "needs_key")
      .map((p) => ({ name: p.id, command: p.mcp!.command, args: p.mcp!.args, env: { ...secretEnv(p), ...(p.mcp!.env ?? {}) } })),
  );
  return list;
}

const secretEnv = (p: Plugin) => {
  const all = secrets();
  return Object.fromEntries((p.secrets ?? []).filter((k) => all[k]).map((k) => [k, all[k]]));
};
const missingSecrets = (p: Plugin) => {
  const all = secrets();
  return (p.secrets ?? []).filter((k) => !all[k]);
};

function statusOf(p: Plugin): PluginStatus {
  const s = saved()[p.id];
  if (!s || s.perms !== p.permsKey) return "pending";
  if (!s.enabled) return "disabled";
  if (missingSecrets(p).length) return "needs_key";
  if (p.mcp) return mcpServerError(p.id) ? "failed" : mcpServerTools(p.id) ? "enabled" : "probing";
  const pr = mem.probes.get(p.id);
  if (!pr || pr.stamp !== p.stamp || pr.state === "running") return "probing";
  return pr.state === "failed" ? "failed" : "enabled";
}

/** 新装的（或者权限变了的）：告诉他一次，等他点头。说不出来就贴一句事实 */
function announce(p: Plugin, s?: Saved) {
  if (s?.announced === p.stamp) return;
  patch(p.id, { announced: p.stamp, enabled: false });
  const fact = `「${p.title}」（${p.description.replace(/\s+/g, " ").slice(0, 120)}）${s?.perms ? "更新后要的权限变了" : "装好了"}，还没启用。它${permsText(p)}。`;
  void (async () => {
    let said = "";
    try {
      said = (await speakAsHer(`你新学的一件本事${fact}用一两句话照实告诉他这件本事是什么、它要什么权限，问他要不要启用。他同意之后你要用 plugin_manage 把它启用。`, "", { fresh: true })).trim();
    } catch {}
    const text = said || `${fact}要启用吗？`;
    await inLane(async () => postAssistant(text));
    notify(text);
  })();
}

function run(dir: string, command: string[], args: unknown, timeoutMs: number, env: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const [cmd, ...rest] = command;
    const bin = cmd.startsWith(".") || (cmd.includes("/") && !path.isAbsolute(cmd)) ? path.resolve(dir, cmd) : cmd;
    let out = "";
    let err = "";
    let done = false;
    const finish = (ok: boolean, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, out: text.length > OUT_MAX ? text.slice(0, OUT_MAX) + "\n……（太长，已截断）" : text });
    };
    const child = spawn(bin, rest, {
      cwd: dir,
      env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`, LANG: process.env.LANG || "en_US.UTF-8", LC_ALL: process.env.LC_ALL || "en_US.UTF-8", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, `超过 ${Math.round(timeoutMs / 1000)} 秒没跑完，已经停掉`);
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", (e) => finish(false, `起不来：${e.message}`));
    child.on("close", (code) => (code === 0 ? finish(true, out.trim() || "（跑完了，没有输出）") : finish(false, (err.trim() || out.trim() || `退出码 ${code}`).slice(-2000))));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(args ?? {}));
  });
}

const limit = (t: ToolDef) => Math.min(Math.max(Number(t.timeoutMs) || 60_000, 1_000), 300_000);

/** 启用着的脚本型插件：这一版还没试跑过就把每个工具的 probe 真跑一次，都过了才交给她；过了顺手留一份这一版 */
function verify(p: Plugin) {
  if (p.mcp || missingSecrets(p).length) return;
  if (mem.probes.get(p.id)?.stamp === p.stamp) return;
  mem.probes.set(p.id, { stamp: p.stamp, state: "running", why: "" });
  void (async () => {
    let why = "";
    for (const t of p.tools ?? []) {
      if (!t.probe) continue;
      const r = await run(p.dir, t.command, t.probe, limit(t), secretEnv(p));
      if (!r.ok) {
        why = `${t.name}：${r.out.slice(0, 300)}`;
        break;
      }
    }
    if (mem.probes.get(p.id)?.stamp !== p.stamp) return; // 试的这会儿又改了
    mem.probes.set(p.id, { stamp: p.stamp, state: why ? "failed" : "ok", why });
    console.log(`[dongni] 插件「${p.id}」试跑${why ? `没过：${why.slice(0, 200)}` : "通过，可以用了"}`);
    if (!why) snapshot(p);
  })();
}

/** 留一份这一版，改坏了能退回；只留最近几份 */
function snapshot(p: Plugin) {
  try {
    const base = path.join(VERSIONS, p.id);
    const to = path.join(base, String(Math.round(p.stamp)));
    if (fs.existsSync(to)) return;
    fs.mkdirSync(base, { recursive: true });
    fs.cpSync(p.dir, to, { recursive: true });
    const old = fs.readdirSync(base).sort((a, b) => Number(b) - Number(a)).slice(KEEP_VERSIONS);
    for (const v of old) fs.rmSync(path.join(base, v), { recursive: true, force: true });
  } catch (e) {
    console.warn(`[dongni] 插件「${p.id}」这一版没留成底：${e instanceof Error ? e.message : e}`);
  }
}

// ─────────────────────────── 给聊天那边用 ───────────────────────────

const enabled = (taken: Set<string>) => scan(taken).filter((p) => statusOf(p) === "enabled");
const toolsOf = (p: Plugin): { name: string; description: string; parameters: Record<string, unknown> }[] =>
  p.mcp
    ? (mcpServerTools(p.id) ?? []).map((t) => ({ name: `${p.id}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64), description: t.description, parameters: t.parameters }))
    : (p.tools ?? []).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} } }));

/** 插件多了以后是不是要改成「先取用再用」 */
const twoLevel = (list: Plugin[]) => list.reduce((n, p) => n + toolsOf(p).length, 0) > DIRECT_TOOLS;

/**
 * 交到她手上的插件工具。不多的时候全给；多了就只给这一轮取用过的、加上最近常用的几个——
 * 其余的她在提示词的目录里看得到名字，要用先 use_plugin。不是裁掉，是用到哪个展开哪个。
 */
export function pluginTools(taken: Set<string>, loaded: Set<string> = new Set()) {
  const list = enabled(taken);
  const st = saved();
  const recent = new Set(
    [...list].sort((a, b) => (st[b.id]?.lastUsedAt ?? 0) - (st[a.id]?.lastUsedAt ?? 0)).slice(0, 4).filter((p) => st[p.id]?.lastUsedAt).map((p) => p.id),
  );
  const open = twoLevel(list) ? list.filter((p) => loaded.has(p.id) || recent.has(p.id)) : list;
  return open.flatMap((p) => toolsOf(p).map((t) => ({ type: "function", function: { name: t.name, description: `（${p.title}）${t.description}`, parameters: t.parameters } })));
}

export const needsUsePlugin = (taken: Set<string>) => twoLevel(enabled(taken));

/** 她取用一个插件：返回它的工具名和使用说明；这一轮接下来就能直接调 */
export function usePlugin(taken: Set<string>, id: string): string {
  const p = enabled(taken).find((x) => x.id === id);
  if (!p) return `出错了：没有叫 ${id} 的可用插件。现有的见【你后来学会的本事】。`;
  return `「${p.title}」取到手了，这一轮可以直接用它的工具：${toolsOf(p).map((t) => t.name).join("、")}。${p.usage?.trim() ? `\n怎么用：${p.usage.trim()}` : ""}`;
}

function findTool(name: string): { p: Plugin; def?: ToolDef; mcpTool?: string } | null {
  for (const p of mem.list) {
    if (p.mcp) {
      const hit = (mcpServerTools(p.id) ?? []).find((t) => `${p.id}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64) === name);
      if (hit) return { p, mcpTool: hit.name };
    } else {
      const def = (p.tools ?? []).find((t) => t.name === name);
      if (def) return { p, def };
    }
  }
  return null;
}

export function pluginToolTitle(name: string): string | null {
  const hit = findTool(name);
  return hit ? hit.p.title : null;
}

/** 跑一个插件工具；不是插件的名字返回 null。结果里带 card 的，挂成一张信息卡片 */
export async function runPluginTool(name: string, rawArgs: string, attach?: (md: string) => void): Promise<string | null> {
  const hit = findTool(name);
  if (!hit) return null;
  const { p } = hit;
  if (statusOf(p) !== "enabled") return `出错了：「${p.title}」现在用不了（${STATUS_TEXT[statusOf(p)]}）。照实告诉他。`;
  let args: unknown = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return "出错了：参数不是合法 JSON。";
  }
  const r = hit.def ? await run(p.dir, hit.def.command, args, limit(hit.def), secretEnv(p)) : await runMcpTool(p.id, hit.mcpTool!, args);
  const s = saved()[p.id];
  if (!r.ok) {
    const fails = (s?.fails ?? 0) + 1;
    if (fails >= FAIL_LIMIT) {
      patch(p.id, { fails, enabled: false, why: `连着 ${fails} 次没跑成：${r.out.slice(0, 120)}` });
      mem.at = 0;
      return `出错了：${r.out}\n（「${p.title}」已经连着 ${fails} 次没跑成，自动停用了。照实告诉他这件本事坏了、停了，原因是上面这个。）`;
    }
    patch(p.id, { fails });
    return `出错了：${r.out}`;
  }
  patch(p.id, { fails: 0, uses: (s?.uses ?? 0) + 1, lastUsedAt: Date.now() });
  let text = r.out;
  try {
    const j = JSON.parse(r.out) as { text?: string; card?: { title?: string; rows?: unknown; url?: string } };
    if (j && typeof j === "object" && j.card && typeof j.card === "object") {
      const rows = Array.isArray(j.card.rows) ? j.card.rows.filter((x) => Array.isArray(x) && x.length >= 2).slice(0, 12).map((x) => [String((x as unknown[])[0]).slice(0, 40), String((x as unknown[])[1]).slice(0, 200)]) : [];
      attach?.("```card\n" + JSON.stringify({ type: "info", title: String(j.card.title ?? p.title).slice(0, 80), rows, ...(typeof j.card.url === "string" ? { url: j.card.url } : {}) }) + "\n```");
      text = `${typeof j.text === "string" && j.text.trim() ? j.text.trim() : JSON.stringify({ ...j, card: undefined })}\n（结果已经做成一张卡片贴在你这句话后面，挑他关心的说一两句，别把表念一遍。）`;
    }
  } catch {
    // 不是 JSON：原样给她
  }
  return p.usage?.trim() ? `${text}\n（${p.usage.trim()}）` : text;
}

/** 写进系统提示词：她后来学会的本事的目录。不随插件多少变长太多：一件一行 */
export function pluginCatalog(taken: Set<string>): string {
  const list = enabled(taken);
  if (!list.length) return "";
  const two = twoLevel(list);
  return (
    `- 你后来学会的本事（${two ? "要用哪件，先调 use_plugin 取用，它的工具才到手" : "都是工具，该用就用"}）：\n` +
    list.map((p) => `  - ${p.title}（${p.id}）：${p.description.trim().replace(/\s+/g, " ").slice(0, 160)}`).join("\n")
  );
}

const STATUS_TEXT: Record<PluginStatus, string> = {
  pending: "等他点头",
  disabled: "停用着",
  needs_key: "缺 key",
  probing: "正在试跑",
  failed: "试跑没过",
  enabled: "能用",
};

/** 给她看的状态：哪些本事现在用不了、为什么；哪些在等他点头 */
export function pluginStateLine(taken: Set<string>): string {
  const rows = scan(taken)
    .map((p) => ({ p, st: statusOf(p) }))
    .filter((x) => x.st !== "enabled")
    .map((x) => {
      const why =
        x.st === "needs_key" ? `缺 ${missingSecrets(x.p).join("、")}，跟他要` : x.st === "failed" ? (mem.probes.get(x.p.id)?.why || mcpServerError(x.p.id) || "").replace(/\s+/g, " ").slice(0, 80) : x.st === "disabled" ? saved()[x.p.id]?.why || "他关的" : x.st === "pending" ? `它${permsText(x.p)}` : "";
      return `「${x.p.title}」（${x.p.id}）${STATUS_TEXT[x.st]}${why ? `：${why}` : ""}`;
    });
  const bad = mem.bad.map((b) => `「${b.slice(0, 80)}」写得不对`);
  const all = [...rows, ...bad];
  return all.length ? `后来学的本事里现在不能用的：${all.join("；")}。等他点头的那些，他同意了你就用 plugin_manage 启用。` : "";
}

export type PluginView = { id: string; title: string; description: string; status: PluginStatus; statusText: string; why: string; perms: string; tools: string[]; uses: number; lastUsedAt: number };

/** 给页面和 plugin_manage 看的清单 */
export function listPlugins(taken: Set<string>): PluginView[] {
  const st = saved();
  return scan(taken).map((p) => {
    const status = statusOf(p);
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      status,
      statusText: STATUS_TEXT[status],
      why: status === "failed" ? mem.probes.get(p.id)?.why || mcpServerError(p.id) || "" : status === "disabled" ? st[p.id]?.why || "" : status === "needs_key" ? `缺 ${missingSecrets(p).join("、")}` : "",
      perms: permsText(p),
      tools: toolsOf(p).map((t) => t.name),
      uses: st[p.id]?.uses ?? 0,
      lastUsedAt: st[p.id]?.lastUsedAt ?? 0,
    };
  });
}

/** 启用（也就是点头）、停用、卸载、退回上一版 */
export function managePlugin(taken: Set<string>, action: "enable" | "disable" | "remove" | "rollback", id: string): string {
  mem.at = 0;
  const p = scan(taken).find((x) => x.id === id);
  if (!p) return `出错了：没有叫 ${id} 的插件。`;
  if (action === "enable") {
    patch(id, { enabled: true, perms: p.permsKey, fails: 0, why: "" });
    mem.probes.delete(id);
    mem.at = 0;
    scan(taken);
    const miss = missingSecrets(p);
    return miss.length ? `「${p.title}」点过头了，但还缺 key：${miss.join("、")}。跟他要，他给了用 plugin_secret 存好就能用。` : `「${p.title}」启用了，正在试跑，跑通就能用（几秒钟）。照实告诉他；先别说已经能用了。`;
  }
  if (action === "disable") {
    patch(id, { enabled: false, why: "他关的" });
    mem.at = 0;
    scan(taken);
    return `「${p.title}」停用了，随时可以再开。`;
  }
  if (action === "remove") {
    try {
      fs.mkdirSync(TRASH, { recursive: true });
      fs.renameSync(p.dir, path.join(TRASH, `${id}-${Date.now().toString(36)}`));
      patch(id, { enabled: false, perms: "", why: "卸掉了" });
      mem.at = 0;
      scan(taken);
      return `「${p.title}」卸掉了（文件夹挪进了回收的地方，没有真删）。`;
    } catch (e) {
      return `出错了：没卸成——${e instanceof Error ? e.message : e}`;
    }
  }
  // 退回上一版：最近留底里比现在这版旧的那一份
  try {
    const base = path.join(VERSIONS, id);
    const older = fs.readdirSync(base).map(Number).filter((v) => v < Math.round(p.stamp)).sort((a, b) => b - a)[0];
    if (!older) return `出错了：「${p.title}」没有更早的版本可以退。`;
    fs.mkdirSync(TRASH, { recursive: true });
    fs.renameSync(p.dir, path.join(TRASH, `${id}-${Date.now().toString(36)}`));
    fs.cpSync(path.join(base, String(older)), p.dir, { recursive: true });
    mem.probes.delete(id);
    mem.at = 0;
    scan(taken);
    return `「${p.title}」退回上一版了，正在重新试跑。`;
  } catch (e) {
    return `出错了：没退成——${e instanceof Error ? e.message : e}`;
  }
}
