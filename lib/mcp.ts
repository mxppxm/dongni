import "server-only";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * MCP 客户端（stdio）：把现成的 MCP 服务接进来当她的工具，不用为每个服务单写代码。
 *
 * 配置在 ~/.config/dongni/mcp.json（不进仓库）：
 *   { "servers": { "名字": { "command": "npx", "args": ["-y", "某个-mcp-server"], "env": { "KEY": "…" } } } }
 * 服务启动时连一遍；配置文件改了会自动重连，不用重启她。每个服务的工具以 mcp_<服务名>_<工具名> 交到她手上。
 * 协议：每行一条 JSON-RPC 消息（initialize → notifications/initialized → tools/list → tools/call）。
 */
const CONFIG = process.env.DONGNI_MCP_CONFIG || path.join(os.homedir(), ".config", "dongni", "mcp.json");
const PROTOCOL = "2025-06-18";
const CALL_MS = 120_000;
const INIT_MS = 30_000;

type ServerConfig = { command: string; args?: string[]; env?: Record<string, string>; disabled?: boolean };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type Pending = { ok: (v: unknown) => void; no: (e: Error) => void; timer: NodeJS.Timeout };
type Server = {
  name: string;
  child: ChildProcessWithoutNullStreams | null;
  tools: McpTool[];
  pending: Map<number, Pending>;
  nextId: number;
  error: string;
};

const state = ((globalThis as unknown as { __dongniMcp?: { servers: Map<string, Server>; mtime: number; loading: boolean; checkedAt: number; loadedAt: number } }).__dongniMcp ??= {
  servers: new Map<string, Server>(),
  mtime: -1,
  loading: false,
  checkedAt: 0,
  loadedAt: 0,
});

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
const toolName = (server: string, tool: string) => `mcp_${safe(server)}_${safe(tool)}`.slice(0, 64);

function request(s: Server, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((ok, no) => {
    if (!s.child || s.child.killed) return no(new Error("服务没在运行"));
    const id = s.nextId++;
    const timer = setTimeout(() => {
      s.pending.delete(id);
      no(new Error(`${Math.round(timeoutMs / 1000)} 秒没回`));
    }, timeoutMs);
    s.pending.set(id, { ok, no, timer });
    s.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function stop(s: Server, why: string) {
  for (const p of s.pending.values()) {
    clearTimeout(p.timer);
    p.no(new Error(why));
  }
  s.pending.clear();
  try {
    s.child?.kill();
  } catch {}
  s.child = null;
}

async function connect(name: string, cfg: ServerConfig): Promise<Server> {
  const s: Server = { name, child: null, tools: [], pending: new Map(), nextId: 1, error: "" };
  try {
    const child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, LANG: process.env.LANG || "en_US.UTF-8", ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    s.child = child;
    let buf = "";
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string }; method?: string };
          if (typeof msg.id !== "number" || msg.method) continue; // 服务端发来的通知和请求，这里用不上
          const p = s.pending.get(msg.id);
          if (!p) continue;
          s.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.no(new Error(msg.error.message || "服务报错"));
          else p.ok(msg.result);
        } catch {
          // 不是 JSON 的行（有的服务会往标准输出打日志）忽略
        }
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      s.error = `起不来：${e.message}`;
      stop(s, s.error);
    });
    child.on("close", (code) => {
      if (s.child === child) {
        s.error = s.error || `进程退出了（${code}）`;
        stop(s, s.error);
      }
    });
    await request(s, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "dongni", version: "0.1.0" } }, INIT_MS);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = (await request(s, "tools/list", cursor ? { cursor } : {}, INIT_MS)) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor && tools.length < 200);
    s.tools = tools;
    console.log(`[dongni][mcp] ${name} 接上了，${tools.length} 个工具`);
  } catch (e) {
    s.error = s.error || (e instanceof Error ? e.message : String(e));
    stop(s, s.error);
    console.warn(`[dongni][mcp] ${name} 没接上：${s.error}`);
  }
  return s;
}

/** 按配置文件（重新）连一遍。配置没变、或者正在连，就什么都不做 */
export async function loadMcp(force = false) {
  if (state.loading) return;
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG).mtimeMs;
  } catch {}
  if (!force && mtime === state.mtime) return;
  state.loading = true;
  state.mtime = mtime;
  state.loadedAt = Date.now();
  try {
    for (const s of state.servers.values()) stop(s, "配置变了，重连");
    state.servers.clear();
    if (!mtime) return;
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8")) as { servers?: Record<string, ServerConfig> };
    const entries = Object.entries(cfg.servers ?? {}).filter(([, c]) => c && !c.disabled && typeof c.command === "string");
    const servers = await Promise.all(entries.map(([name, c]) => connect(name, c)));
    for (const s of servers) state.servers.set(s.name, s);
  } catch (e) {
    console.warn(`[dongni][mcp] 配置读不了：${e instanceof Error ? e.message : e}`);
  } finally {
    state.loading = false;
  }
}

/** 顺手看一眼配置改没改（几秒看一次），改了就在后台重连；断了的服务也在这里重连 */
function refresh() {
  if (Date.now() - state.checkedAt < 5_000) return;
  state.checkedAt = Date.now();
  // 有服务断了：隔一分钟重连一遍；否则只在配置文件改过时重连
  const dead = [...state.servers.values()].some((s) => !s.child);
  void loadMcp(dead && Date.now() - state.loadedAt > 60_000);
}

export function mcpTools() {
  refresh();
  const out: unknown[] = [];
  for (const s of state.servers.values())
    for (const t of s.child ? s.tools : [])
      out.push({
        type: "function",
        function: {
          name: toolName(s.name, t.name),
          description: `（来自 ${s.name}）${(t.description ?? t.name).slice(0, 900)}`,
          parameters: t.inputSchema && (t.inputSchema as { type?: string }).type === "object" ? t.inputSchema : { type: "object", properties: {} },
        },
      });
  return out;
}

function find(name: string): { s: Server; tool: McpTool } | null {
  for (const s of state.servers.values()) for (const tool of s.tools) if (toolName(s.name, tool.name) === name) return { s, tool };
  return null;
}

export function mcpTitle(name: string): string | null {
  const hit = find(name);
  return hit ? `${hit.s.name}：${hit.tool.name}` : null;
}

/** 调一个 MCP 工具；不是 MCP 的名字返回 null */
export async function runMcp(name: string, rawArgs: string): Promise<string | null> {
  const hit = find(name);
  if (!hit) return null;
  let args: unknown = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return "出错了：参数不是合法 JSON。";
  }
  try {
    const r = (await request(hit.s, "tools/call", { name: hit.tool.name, arguments: args }, CALL_MS)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    const text =
      (r.content ?? [])
        .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type ?? "内容"}]`))
        .join("\n")
        .trim() || (r.structuredContent ? JSON.stringify(r.structuredContent) : "（没有返回内容）");
    return r.isError ? `出错了：${text.slice(0, 2000)}` : text;
  } catch (e) {
    return `出错了：${hit.s.name} 没调通——${e instanceof Error ? e.message : e}`;
  }
}

/** 给她看的状态：哪些外接服务没接上 */
export function mcpStateLine(): string {
  const bad = [...state.servers.values()].filter((s) => !s.child).map((s) => `「${s.name}」（${s.error.slice(0, 60) || "断了"}）`);
  return bad.length ? `外接的服务里现在没接上的：${bad.join("；")}。` : "";
}
