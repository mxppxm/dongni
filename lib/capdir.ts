import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 能力目录：给她加一件新本事 = 加一个文件夹，不改代码、不重启。
 *
 *   ~/.config/dongni/capabilities/<名字>/capability.json   说明：叫什么、什么时候用、要什么参数、怎么跑
 *   ~/.config/dongni/capabilities/<名字>/…                 跑的那个脚本（什么语言都行）
 *
 * 每次要用工具清单时扫一遍（几秒内的重复扫描走缓存）。脚本从标准输入拿到参数（JSON），把结果打到标准输出。
 * 写了 probe 的能力，第一次见到（或者改过）会先真跑一次 probe，跑通才交到她手上；跑不通就不给她，原因记在状态里。
 * 完整规范在同一目录的 SPEC.md（第一次用到时自动写出来），后台的活照着它写。
 */
export const CAP_DIR = process.env.DONGNI_CAP_DIR || path.join(os.homedir(), ".config", "dongni", "capabilities");
const SCAN_TTL = 3_000;
const OUT_MAX = 20_000;

type Manifest = {
  name: string;
  title?: string;
  description: string;
  parameters?: Record<string, unknown>;
  command: string[];
  timeoutMs?: number;
  probe?: Record<string, unknown>;
};
type Cap = Manifest & { dir: string; stamp: number };
/** 探针结果按「名字 + 文件改动时间」记：改过就重新验 */
type Probe = { stamp: number; state: "running" | "ok" | "failed"; why: string };

const state = ((globalThis as unknown as { __dongniCaps?: { at: number; caps: Cap[]; bad: string[]; probes: Map<string, Probe> } }).__dongniCaps ??= {
  at: 0,
  caps: [],
  bad: [],
  probes: new Map<string, Probe>(),
});

const SPEC = `# 能力规范

给聊天应用里的她加一件新本事：在这个目录下建一个文件夹，放一份 capability.json 和要跑的脚本。不用改她的代码，不用重启，几秒后她手里就多一件工具。

## capability.json

\`\`\`json
{
  "name": "get_weather",
  "title": "查天气",
  "description": "查某个城市现在的天气和未来三天预报。他问天气、要不要带伞、穿什么时用。",
  "parameters": {
    "type": "object",
    "properties": { "city": { "type": "string", "description": "城市名，中文或拼音" } },
    "required": ["city"]
  },
  "command": ["python3", "run.py"],
  "timeoutMs": 30000,
  "probe": { "city": "北京" }
}
\`\`\`

- name：小写字母开头，只含小写字母、数字、下划线，3 到 40 个字符，不能和已有工具重名。
- title：任务栏上显示的短名字。
- description：写清楚这件本事是什么、什么时候该用。她只看这段话决定用不用。
- parameters：JSON Schema，顶层必须是 object。
- command：要跑的命令，数组形式。在这个能力自己的文件夹里执行；第一个元素写相对路径时按这个文件夹算。
- timeoutMs：最长跑多久，默认 60000，最大 300000。
- probe：一组真实可用的参数。写了的话，第一次加载会先拿它真跑一次，退出码是 0 才算这个能力可用。强烈建议写。

## 脚本约定

- 参数：一个 JSON 对象，从标准输入读。
- 结果：打到标准输出，纯文本或 JSON 都行，写给她看，说清楚查到了什么。别超过两万字。
- 出错：退出码非 0，原因打到标准错误。她会照实告诉他。
- 密钥：不要写进脚本和 capability.json。需要的话从环境变量或 ~/.config/dongni/ 下的单独文件里读，文件权限 600。
- 脚本要能重复跑；不要交互式提问；不要常驻。

## 写完之后

自己用 probe 那组参数跑一遍，确认退出码是 0、输出像样，再收尾。
`;

function ensureSpec() {
  try {
    fs.mkdirSync(CAP_DIR, { recursive: true });
    const file = path.join(CAP_DIR, "SPEC.md");
    if (!fs.existsSync(file)) fs.writeFileSync(file, SPEC, "utf8");
  } catch {}
}

function scan(taken: Set<string>): Cap[] {
  if (Date.now() - state.at < SCAN_TTL) return state.caps;
  state.at = Date.now();
  ensureSpec();
  const caps: Cap[] = [];
  const bad: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(CAP_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {}
  for (const folder of names.sort()) {
    const dir = path.join(CAP_DIR, folder);
    const file = path.join(dir, "capability.json");
    try {
      const m = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
      if (!/^[a-z][a-z0-9_]{2,39}$/.test(String(m.name))) throw new Error("name 不合规范");
      if (taken.has(m.name) || caps.some((c) => c.name === m.name)) throw new Error(`name 和已有工具重名：${m.name}`);
      if (!m.description?.trim()) throw new Error("缺 description");
      if (!Array.isArray(m.command) || !m.command.length || m.command.some((x) => typeof x !== "string")) throw new Error("command 要写成字符串数组");
      if (m.parameters && (m.parameters as { type?: string }).type !== "object") throw new Error("parameters 顶层必须是 object");
      // 文件夹里任何一个文件改过都算改过：脚本改了也要重新验
      const stamp = Math.max(...fs.readdirSync(dir).map((n) => fs.statSync(path.join(dir, n)).mtimeMs));
      caps.push({ ...m, dir, stamp });
    } catch (e) {
      bad.push(`${folder}：${e instanceof Error ? e.message : e}`);
    }
  }
  state.caps = caps;
  state.bad = bad;
  for (const c of caps) verify(c);
  return caps;
}

function run(cap: Cap, args: unknown, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const [cmd, ...rest] = cap.command;
    const bin = cmd.startsWith(".") || (cmd.includes("/") && !path.isAbsolute(cmd)) ? path.resolve(cap.dir, cmd) : cmd;
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
      cwd: cap.dir,
      env: { ...process.env, LANG: process.env.LANG || "en_US.UTF-8", LC_ALL: process.env.LC_ALL || "en_US.UTF-8" },
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

const limit = (cap: Cap) => Math.min(Math.max(Number(cap.timeoutMs) || 60_000, 1_000), 300_000);

/** 写了 probe 的：这一版还没验过就真跑一次。没写 probe 的直接算可用 */
function verify(cap: Cap) {
  const seen = state.probes.get(cap.name);
  if (seen?.stamp === cap.stamp) return;
  if (!cap.probe) {
    state.probes.set(cap.name, { stamp: cap.stamp, state: "ok", why: "" });
    return;
  }
  state.probes.set(cap.name, { stamp: cap.stamp, state: "running", why: "" });
  void run(cap, cap.probe, limit(cap)).then((r) => {
    if (state.probes.get(cap.name)?.stamp !== cap.stamp) return; // 验的这会儿又改了
    state.probes.set(cap.name, { stamp: cap.stamp, state: r.ok ? "ok" : "failed", why: r.ok ? "" : r.out.slice(0, 300) });
    console.log(`[dongni] 能力「${cap.name}」试跑${r.ok ? "通过，可以用了" : `没过：${r.out.slice(0, 200)}`}`);
  });
}

const usable = (taken: Set<string>) => scan(taken).filter((c) => state.probes.get(c.name)?.state === "ok");

/** 交到她手上的工具定义（OpenAI 工具格式） */
export function capTools(taken: Set<string>) {
  return usable(taken).map((c) => ({
    type: "function",
    function: { name: c.name, description: c.description, parameters: c.parameters ?? { type: "object", properties: {} } },
  }));
}

export function capTitle(name: string): string | null {
  const c = state.caps.find((x) => x.name === name);
  return c ? c.title?.trim() || c.name : null;
}

/** 跑一个能力；不是能力目录里的名字返回 null */
export async function runCap(name: string, rawArgs: string): Promise<string | null> {
  const cap = state.caps.find((c) => c.name === name);
  if (!cap) return null;
  let args: unknown = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return "出错了：参数不是合法 JSON。";
  }
  const r = await run(cap, args, limit(cap));
  return r.ok ? r.out : `出错了：${r.out}`;
}

/** 写进系统提示词：她后来学会的本事 */
export function capPromptLines(taken: Set<string>): string {
  return usable(taken)
    .map((c) => `- ${c.title?.trim() || c.name}（${c.name}）：${c.description.trim().replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n");
}

/** 给她看的状态：哪些本事加了但现在用不了，为什么 */
export function capStateLine(): string {
  const failed = state.caps
    .map((c) => ({ c, p: state.probes.get(c.name) }))
    .filter((x) => x.p && x.p.state !== "ok")
    .map((x) => `「${x.c.title?.trim() || x.c.name}」${x.p!.state === "running" ? "还在试跑" : `试跑没过（${x.p!.why.replace(/\s+/g, " ").slice(0, 80)}）`}`);
  const bad = state.bad.map((b) => `「${b.slice(0, 80)}」写得不对`);
  const all = [...failed, ...bad];
  return all.length ? `后来加的本事里现在用不了的：${all.join("；")}。` : "";
}
