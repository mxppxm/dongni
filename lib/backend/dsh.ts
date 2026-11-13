import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getKv, setKv } from "../db";
import type { JobStage } from "../tasks";
import type { Backend, Job, JobHooks } from "./types";

/**
 * DSH superagent 后端：往它的本地收件箱丢一个任务文件，它开工单、在自己的会话和目录里干，回复写回 replies/。
 * 工单存在它自己的库里，所以这边服务重启不影响在跑的活——重启后把还开着的接回来接着盯就行。
 *
 * 收件箱：<inbox>/pending/<任务>.json 投进去；<inbox>/replies/<任务>/<编号>.md 是它的每一条回复，
 * 第一行是 `<!-- 类型 · ticket 工单号 -->`，类型有 acknowledgement（接单）、reply（回复）、notice（通知）。
 * 工单走到哪一步、叫停，走它面板的本机接口（只认本机、要带 x-orchestrator-request 头）。
 */
const INBOX = process.env.DONGNI_DSH_INBOX || path.join(os.homedir(), ".dsh", "state", "superagent", "inbox");
const PANEL = (process.env.DONGNI_DSH_URL || "http://127.0.0.1:3082").replace(/\/$/, "");
const POLL_MS = 3_000;
/** 没有新回复时，隔这么久去问一次工单走到哪了 */
const TICKET_EVERY_MS = 15_000;
/** 投进去这么久还没人接单：多半是它没在收，别让这件活无声无息地挂着 */
const ACK_LIMIT_MS = 5 * 60_000;

/**
 * 把 superagent 拉起来：用它自带的管理脚本（scripts/dsh-superagent start）。
 * 脚本把它放进 tmux 里跑——跟这个服务不是父子进程，这边重启（改完自己会重启）不会把它那边在干的活带走；
 * 已经在跑就什么都不做，不会起第二个。他手动停过（脚本留了 manually-stopped 标记）就不去拉，尊重他停的决定。
 */
const SCRIPT = process.env.DONGNI_DSH_SCRIPT || path.join(os.homedir(), "src", "dsh-superagent-prototype", "scripts", "dsh-superagent");
const PROFILE = process.env.DSH_SUPERAGENT_PROFILE || "superagent";
const START_EVERY_MS = 3 * 60_000;
const boot = ((globalThis as unknown as { __dongniDshBoot?: { at: number; busy: boolean } }).__dongniDshBoot ??= { at: 0, busy: false });

export function ensureSuperagent(why: string) {
  if (process.env.DONGNI_DSH === "off" || process.env.DONGNI_DSH_AUTOSTART === "off") return;
  if (boot.busy || Date.now() - boot.at < START_EVERY_MS) return;
  if (!fs.existsSync(SCRIPT)) return;
  const stopped = path.join(path.dirname(SCRIPT), "..", ".artifacts", "control", "profiles", PROFILE, "manually-stopped");
  if (fs.existsSync(stopped)) {
    console.log("[dongni][dsh] superagent 是他手动停的，不自动拉起");
    return;
  }
  boot.at = Date.now();
  boot.busy = true;
  console.log(`[dongni][dsh] 拉起 superagent（${why}）`);
  execFile(
    "/usr/bin/python3",
    [SCRIPT, "start", "--profile", PROFILE, "--url", PANEL],
    {
      timeout: 150_000,
      // 这个服务是 launchd 起的，PATH 里没有 Homebrew：脚本要找 tmux
      env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`, LANG: process.env.LANG || "en_US.UTF-8" },
    },
    (err, stdout, stderr) => {
      boot.busy = false;
      const said = `${stdout}${stderr}`.trim().split("\n").slice(-3).join(" ｜ ").slice(0, 300);
      // 退出码 2/3 表示起来了但有部件报错或在等配置：照样算起来了，原因记日志
      console.log(`[dongni][dsh] superagent ${err && (err as { code?: number }).code === 1 ? "没拉起来" : "拉起流程走完"}：${said || (err ? err.message : "ok")}`);
    },
  );
}

type Watch = { job: Job; hooks: JobHooks; seen: Set<string>; ticket: string; asked: string; summary: string; since: number; lastTicketAt: number; busy: boolean };
type Saved = { seen: string[]; ticket: string; asked: string; since: number; summary?: string };

const state = ((globalThis as unknown as { __dongniDsh?: { watches: Map<number, Watch>; timer: NodeJS.Timeout | null } }).__dongniDsh ??= {
  watches: new Map<number, Watch>(),
  timer: null,
});

const savedKey = (id: number) => `dsh_watch:${id}`;
function save(w: Watch) {
  setKv(savedKey(w.job.id), JSON.stringify({ seen: [...w.seen], ticket: w.ticket, asked: w.asked, since: w.since, summary: w.summary } satisfies Saved));
}

async function api(method: "GET" | "POST", route: string, timeoutMs = 4_000): Promise<Record<string, unknown>> {
  const res = await fetch(`${PANEL}/orchestrator/api/${route}`, {
    method,
    headers: { "x-orchestrator-request": "1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

type Ticket = {
  state?: string;
  stage?: string;
  action?: string;
  summary?: string;
  ended?: { outcome?: string; by?: string; reason?: string };
  attention?: { id?: string; question?: string };
};

/** 工单现在算什么：还在干 / 在等他回答 / 已经有结论 */
function readTicket(t: Ticket): { kind: "open"; stage: JobStage } | { kind: "ask"; id: string; question: string } | { kind: "end"; stage: "done" | "failed" | "stopped" } {
  if (t.state === "ended" || t.stage === "ended" || t.ended) {
    const how = `${t.ended?.outcome ?? ""} ${t.ended?.by ?? ""} ${t.ended?.reason ?? ""}`;
    if (/stop/i.test(how)) return { kind: "end", stage: "stopped" };
    if (/fail|block|error/i.test(how)) return { kind: "end", stage: "failed" };
    return { kind: "end", stage: "done" };
  }
  if (t.stage === "person") {
    if (t.action === "answer") return { kind: "ask", id: String(t.attention?.id ?? ""), question: String(t.attention?.question ?? "") };
    if (t.action === "blocked" || t.action === "failed") return { kind: "end", stage: "failed" };
    if (t.action === "review") return { kind: "end", stage: "done" };
  }
  return { kind: "open", stage: t.stage === "working" && t.action === "queued" ? "queued" : "working" };
}

function replyFiles(extId: string): string[] {
  const dir = path.join(INBOX, "replies", extId);
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => ({ n, at: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.n);
  } catch {
    return [];
  }
}

function readReply(extId: string, name: string) {
  const raw = fs.readFileSync(path.join(INBOX, "replies", extId, name), "utf8");
  const head = raw.match(/^<!--\s*([a-z]+)\s*·\s*ticket\s+(\S+)\s*-->\n?/);
  return { kind: head?.[1] ?? "", ticket: head && head[2] !== "-" ? head[2] : "", text: (head ? raw.slice(head[0].length) : raw).trim() };
}

function drop(w: Watch) {
  state.watches.delete(w.job.id);
  setKv(savedKey(w.job.id), "");
}

async function check(w: Watch) {
  let finalText = "";
  for (const name of replyFiles(w.job.extId)) {
    if (w.seen.has(name)) continue;
    w.seen.add(name);
    const r = readReply(w.job.extId, name);
    if (r.ticket) w.ticket = r.ticket;
    if (r.kind === "acknowledgement") w.hooks.event("ack", r.text, "working");
    else if (r.kind === "notice") w.hooks.event("notice", r.text);
    else finalText = r.text || finalText; // reply：它给人的话——结果，或者一个要他回答的问题
    save(w);
  }

  // 工单走到哪了：有新回复时一定问一次（分清是结果还是提问），平时隔一阵问一次
  let ticket: ReturnType<typeof readTicket> | null = null;
  let summary = "";
  if (w.ticket && (finalText || Date.now() - w.lastTicketAt > TICKET_EVERY_MS)) {
    w.lastTicketAt = Date.now();
    try {
      const t = (await api("GET", `tickets/${encodeURIComponent(w.ticket)}`)) as Ticket;
      ticket = readTicket(t);
      summary = String(t.summary ?? "");
    } catch {
      // 面板问不到（它在重启、没开）：有回复就照回复办，没有就下一轮再问
    }
  }

  if (ticket?.kind === "ask") {
    if (ticket.id !== w.asked || finalText) {
      w.asked = ticket.id;
      save(w);
      w.hooks.event("ask", finalText || ticket.question, "asking");
    }
    return;
  }
  if (finalText) {
    drop(w);
    return w.hooks.finish(ticket?.kind === "end" ? ticket.stage : "done", finalText);
  }
  if (ticket?.kind === "end") {
    drop(w);
    return w.hooks.finish(ticket.stage, summary || "它那边结束了，没有留下说明。");
  }
  if (ticket?.kind === "open") {
    w.hooks.event("stage", "", ticket.stage);
    // 它的执行器报了新的进展（工单上最近一条报告的摘要变了）
    if (summary && summary !== w.summary) {
      w.summary = summary;
      save(w);
      w.hooks.event("progress", summary);
    }
  }
  if (!w.ticket && Date.now() - w.since > ACK_LIMIT_MS) {
    drop(w);
    try {
      fs.rmSync(path.join(INBOX, "pending", `${w.job.extId}.json`), { force: true });
    } catch {}
    w.hooks.finish("failed", `交给 superagent ${Math.round(ACK_LIMIT_MS / 60_000)} 分钟了一直没人接单，这件没做。`);
  }
}

function ensureTimer() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    for (const w of state.watches.values()) {
      if (w.busy) continue;
      w.busy = true;
      void check(w)
        .catch((e) => console.warn(`[dongni][dsh] 任务 ${w.job.id} 这一轮没看成：`, e instanceof Error ? e.message : e))
        .finally(() => (w.busy = false));
    }
    if (!state.watches.size && state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }, POLL_MS);
  state.timer.unref?.();
}

function watch(job: Job, hooks: JobHooks, saved?: Saved) {
  state.watches.set(job.id, {
    job,
    hooks,
    seen: new Set(saved?.seen ?? []),
    ticket: saved?.ticket ?? "",
    asked: saved?.asked ?? "",
    summary: saved?.summary ?? "",
    since: saved?.since ?? Date.now(),
    lastTicketAt: 0,
    busy: false,
  });
  ensureTimer();
}

export const dshBackend: Backend = {
  name: "dsh",

  async unavailable() {
    if (process.env.DONGNI_DSH === "off") return "superagent 被关掉了（DONGNI_DSH=off）";
    try {
      const s = (await api("GET", "state", 1_500)) as { paused?: boolean; setup?: { problem?: unknown }; health?: Record<string, { state?: string; detail?: string }> };
      if (s.setup?.problem) return "superagent 还没配置完";
      if (s.paused) return "superagent 被暂停了";
      const local = s.health?.local;
      if (!local) return "superagent 没开本地收件箱";
      if (local.state !== "ready") return `superagent 的本地收件箱没在收（${local.state ?? "未知"}）`;
      return null;
    } catch (e) {
      // 没在线：顺手拉一把（这件活先走别的后端，它起来之后的活再交给它）
      ensureSuperagent("派活时发现它没在线");
      return `superagent 没在线（${e instanceof Error ? e.message : e}）`;
    }
  },

  start(job: Job, hooks: JobHooks) {
    try {
      const extId = `dn-${job.id}-${Date.now().toString(36)}`;
      const pending = path.join(INBOX, "pending");
      fs.mkdirSync(pending, { recursive: true });
      // 先写成别的后缀再改名：它只认 .json，不会读到写了一半的文件
      const tmp = path.join(pending, `${extId}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ id: extId, text: job.request, from: "owner", cwd: job.dir, at: new Date().toISOString() }), "utf8");
      fs.renameSync(tmp, path.join(pending, `${extId}.json`));
      hooks.ext(extId);
      const mine = { ...job, extId };
      watch(mine, hooks);
      save(state.watches.get(job.id)!);
      hooks.event("sent", "任务文件投进 superagent 的收件箱了", "queued");
    } catch (e) {
      hooks.finish("failed", `没能交给 superagent：${e instanceof Error ? e.message : e}`);
    }
  },

  resume(job: Job, hooks: JobHooks) {
    if (!job.extId) return false;
    let saved: Saved | undefined;
    try {
      saved = JSON.parse(getKv(savedKey(job.id)) || "null") ?? undefined;
    } catch {}
    watch(job, hooks, saved);
    return true;
  },

  async cancel(job: Job) {
    const w = state.watches.get(job.id);
    const pending = path.join(INBOX, "pending", `${job.extId}.json`);
    // 还没被收走：把文件拿掉就等于没派
    if (fs.existsSync(pending)) {
      fs.rmSync(pending, { force: true });
      if (w) drop(w);
      return null;
    }
    if (!w?.ticket) return "superagent 那边还没开出工单，现在停不了，过一会儿再停";
    try {
      await api("POST", `tickets/${encodeURIComponent(w.ticket)}/stop`);
      drop(w);
      return null;
    } catch (e) {
      return `superagent 没停成：${e instanceof Error ? e.message : e}`;
    }
  },

  // 往同一件活的线程里再投一个文件（thread 指回原任务）：它那边直接送到这件活的执行器手里，回复还落在原来的目录
  async append(job: Job, text: string) {
    if (!job.extId) return "这件活在 superagent 那边还没有编号";
    try {
      const id = `${job.extId}-f${Date.now().toString(36)}`;
      const pending = path.join(INBOX, "pending");
      fs.mkdirSync(pending, { recursive: true });
      const tmp = path.join(pending, `${id}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ id, thread: job.extId, text, from: "owner", at: new Date().toISOString() }), "utf8");
      fs.renameSync(tmp, path.join(pending, `${id}.json`));
      return null;
    } catch (e) {
      return `没能投进 superagent 的收件箱：${e instanceof Error ? e.message : e}`;
    }
  },
};
