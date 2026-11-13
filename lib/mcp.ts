import "server-only";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * MCP 客户端（stdio）：把现成的 MCP 服务接进来当她的工具，不用为每个服务单写代码。
 *
 * 哪些服务要起，由插件说了算（lib/plugins.ts：清单里写了 mcp 的插件，启用着就起，停用、卸载就停）。
 * 这里只管连接：起进程、握手、列工具、调工具、断了重连。
 * 协议：每行一条 JSON-RPC 消息（initialize → notifications/initialized → tools/list → tools/call）。
 */
const PROTOCOL = "2025-06-18";
const CALL_MS = 120_000;
const INIT_MS = 30_000;
const RETRY_MS = 60_000;

export type McpServerConfig = { name: string; command: string; args?: string[]; env?: Record<string, string> };
type ServerConfig = { command: string; args?: string[]; env?: Record<string, string> };
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
/** sig：这份配置的指纹，变了就重连；connecting：正在连；triedAt：上次连的时间（连不上隔一阵再试） */
type Slot = { sig: string; server: Server | null; connecting: boolean; triedAt: number };

const state = ((globalThis as unknown as { __dongniMcpSlots?: Map<string, Slot> }).__dongniMcpSlots ??= new Map<string, Slot>());

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

/**
 * 现在该起着的服务就是这一份名单：名单里新出现的、配置变了的连上，不在名单里的停掉，断了的隔一阵重连。
 * 调用很便宜（插件每次扫描都会调），连接在后台做。
 */
export function syncMcpServers(want: McpServerConfig[]) {
  const names = new Set(want.map((w) => w.name));
  for (const [name, slot] of state) {
    if (names.has(name)) continue;
    if (slot.server) stop(slot.server, "停用了");
    state.delete(name);
  }
  for (const w of want) {
    const sig = JSON.stringify([w.command, w.args ?? [], w.env ?? {}]);
    let slot = state.get(w.name);
    if (slot && slot.sig !== sig) {
      if (slot.server) stop(slot.server, "配置变了，重连");
      slot = undefined;
    }
    if (!slot) {
      slot = { sig, server: null, connecting: false, triedAt: 0 };
      state.set(w.name, slot);
    }
    const alive = !!slot.server?.child;
    if (alive || slot.connecting || Date.now() - slot.triedAt < RETRY_MS) continue;
    slot.connecting = true;
    slot.triedAt = Date.now();
    const mine = slot;
    void connect(w.name, { command: w.command, args: w.args, env: w.env })
      .then((s) => {
        // 连的这会儿它被停用或者换了配置：这条连接不要了
        if (state.get(w.name) !== mine) return stop(s, "不需要了");
        mine.server = s;
      })
      .finally(() => (mine.connecting = false));
  }
}

/** 这个服务报上来的工具；还没连上返回 null */
export function mcpServerTools(name: string): { name: string; description: string; parameters: Record<string, unknown> }[] | null {
  const s = state.get(name)?.server;
  if (!s?.child) return null;
  return s.tools.map((t) => ({
    name: t.name,
    description: (t.description ?? t.name).slice(0, 900),
    parameters: t.inputSchema && (t.inputSchema as { type?: string }).type === "object" ? t.inputSchema : { type: "object", properties: {} },
  }));
}

/** 这个服务没连上的原因；连着、或者还没试过，返回空串 */
export function mcpServerError(name: string): string {
  const slot = state.get(name);
  if (!slot || slot.connecting || slot.server?.child) return "";
  return slot.server?.error || "";
}

export async function runMcpTool(server: string, tool: string, args: unknown): Promise<{ ok: boolean; out: string }> {
  const s = state.get(server)?.server;
  if (!s?.child) return { ok: false, out: `${server} 这个服务没连上` };
  try {
    const r = (await request(s, "tools/call", { name: tool, arguments: args ?? {} }, CALL_MS)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    const text =
      (r.content ?? [])
        .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type ?? "内容"}]`))
        .join("\n")
        .trim() || (r.structuredContent ? JSON.stringify(r.structuredContent) : "（没有返回内容）");
    return { ok: !r.isError, out: text.slice(0, 20_000) };
  } catch (e) {
    return { ok: false, out: `${server} 没调通——${e instanceof Error ? e.message : e}` };
  }
}
