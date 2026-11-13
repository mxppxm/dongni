"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, ListTodo, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Balance from "./Balance";

type Task = {
  id: number;
  kind: string;
  title: string;
  status: "running" | "done" | "error";
  result: string;
  startedAt: number;
  endedAt: number | null;
  /** 后台在跑的活的真实动静：第几步、多久没动（秒）、正在干什么、最近几个动作 */
  live?: { steps: number; idleSec: number; doing: string; recent: { at: number; text: string }[] } | null;
  /** 还没开工时卡在哪：排队、等接单、在等他回答 */
  waiting?: string;
};

/** 一句话：这件活现在什么情况。两分钟没动静就明说 */
const liveLine = (t: Task) => {
  const l = t.live;
  if (!l) return t.waiting ?? "";
  if (l.idleSec >= 120) return `${Math.floor(l.idleSec / 60)} 分钟没动静了${l.idleSec >= 300 ? "，可能卡住了" : ""}${l.steps ? `（停在第 ${l.steps} 步）` : ""}`;
  return `${l.steps ? `第 ${l.steps} 步 · ` : ""}${l.doing || "在干"}`;
};
const stalled = (t: Task) => !!t.live && t.live.idleSec >= 120;

const ago = (ts: number, now: number) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const took = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`);
const clock = (ts: number) => {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

const LABEL: Record<Task["status"], string> = { running: "正在跑", done: "完成", error: "出错" };

const images = (md: string) => [...md.matchAll(/!\[[^\]]*\]\((\/api\/[^)\s]+)\)/g)].map((m) => m[1]);
const files = (md: string) =>
  [...md.matchAll(/```card\n([\s\S]*?)\n```/g)]
    .map((m) => {
      try {
        const c = JSON.parse(m[1]);
        return c.type === "file" ? (c.path as string) : null;
      } catch {
        return null;
      }
    })
    .filter((p): p is string => !!p);
const plain = (md: string) =>
  md
    .replace(/```card\n[\s\S]*?\n```/g, "")
    .replace(/!\[[^\]]*\]\(\/api\/[^)\s]+\)/g, "")
    .trim();

/** 点开一条任务：状态、开始时间、跑了多久、描述和输出都在这儿，右上角能关掉 */
function Detail({ t, now, onClose }: { t: Task; now: number; onClose: () => void }) {
  const imgs = images(t.result);
  const fs = files(t.result);
  const text = plain(t.result);
  const ms = (t.status === "running" ? now : (t.endedAt ?? t.startedAt)) - t.startedAt;
  return (
    <div className="mt-1 mb-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-2.5 backdrop-blur-xl">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={`text-[11.5px] ${t.status === "error" ? "text-[#f05252]/80" : t.status === "running" ? "text-[var(--text)]" : "text-[var(--dim)]"}`}>
          {LABEL[t.status]}
        </span>
        <span className="ml-auto text-[11px] text-[var(--faint)] tabular-nums">
          {t.status === "running" ? `已 ${took(ms)}` : `用时 ${took(ms)}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
        >
          <X size={11} />
        </button>
      </div>
      <div className="space-y-0.5 text-[11.5px] leading-relaxed">
        <div className="flex gap-2">
          <span className="w-7 shrink-0 text-[var(--faint)]">开始</span>
          <span className="min-w-0 flex-1 text-[var(--dim)] tabular-nums">{clock(t.startedAt)}</span>
        </div>
        <div className="flex gap-2">
          <span className="w-7 shrink-0 text-[var(--faint)]">描述</span>
          <span className="min-w-0 flex-1 break-words text-[var(--dim)]">{t.title}</span>
        </div>
      </div>
      {(!!text || !!imgs.length || !!fs.length || t.status === "running") && (
        <div className="mt-2 space-y-1.5 border-t border-[var(--border)] pt-2">
          {!!imgs.length &&
            imgs.map((src) => (
              <a key={src} href={src} target="_blank" rel="noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" className="max-h-40 rounded-lg border border-[var(--border)] object-cover" />
              </a>
            ))}
          {fs.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => fetch("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) })}
              className="block max-w-full truncate text-left text-[11.5px] text-[var(--dim)] underline-offset-2 hover:underline"
              title={p}
            >
              {p.split("/").pop()}
            </button>
          ))}
          {t.status === "running" && (t.live || t.waiting) && (
            <div className="space-y-0.5 text-[11.5px] leading-relaxed">
              <div className={stalled(t) ? "text-[#f05252]/80" : "text-[var(--dim)]"}>{liveLine(t)}</div>
              {(t.live?.recent ?? [])
                .slice(0, -1)
                .reverse()
                .map((r, i) => (
                  <div key={i} className="flex gap-2 text-[var(--faint)]">
                    <span className="shrink-0 tabular-nums">{new Date(r.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
                    <span className="min-w-0 break-words">{r.text}</span>
                  </div>
                ))}
            </div>
          )}
          {text && <div className="scroll-thin max-h-40 overflow-y-auto overscroll-contain text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-[var(--faint)]">{text}</div>}
          {t.status === "running" && !text && !t.live && !t.waiting && (
            <div className="text-[11.5px] leading-relaxed text-[var(--faint)]">还在跑，暂时没有输出</div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ t, now, open, onToggle }: { t: Task; now: number; open: boolean; onToggle: () => void }) {
  return (
    <motion.li layout initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left transition-colors ${open ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]"}`}
      >
        <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          {t.status === "running" ? (
            <LoaderCircle size={13} className="animate-spin text-[var(--dot)]" />
          ) : t.status === "done" ? (
            <Check size={13} className="text-[var(--faint)]" />
          ) : (
            <X size={13} className="text-[#f05252]/70" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] ${t.status === "running" ? "text-[var(--text)]" : "text-[var(--dim)]"}`} title={t.title}>
            {t.title}
          </span>
          <span className="block text-[11px] text-[var(--faint)] tabular-nums">
            {t.status === "running" ? `已 ${took(now - t.startedAt)}` : ago(t.endedAt ?? t.startedAt, now)}
          </span>
          {t.status === "running" && liveLine(t) && (
            <span className={`block truncate text-[11px] ${stalled(t) ? "text-[#f05252]/80" : "text-[var(--dim)]"}`} title={liveLine(t)}>
              {liveLine(t)}
            </span>
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden pl-5 pr-0.5"
          >
            <Detail t={t} now={now} onClose={onToggle} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

/* ---------- 在跑的活有几件：输入框边框的流光跟着它走 ---------- */
// 0 件就是在跑/在派/在改/排队的都没有；1~2 件算一档；3 件以上一档
let runningCount = 0;
const busyHooks = new Set<() => void>();
const subscribeBusy = (fn: () => void) => {
  busyHooks.add(fn);
  return () => {
    busyHooks.delete(fn);
  };
};
const setRunningCount = (n: number) => {
  if (n === runningCount) return;
  runningCount = n;
  busyHooks.forEach((fn) => fn());
};
/** 当前在跑的活有几件（0 表示闲着） */
export function useRunningTasks() {
  return useSyncExternalStore(
    subscribeBusy,
    () => runningCount,
    () => 0,
  );
}

/** 左边的任务栏：她动手干的事一件件列着，跑着的转圈，点开能看细节和结果 */
export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [drawer, setDrawer] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { tasks } = (await (await fetch("/api/tasks")).json()) as { tasks: Task[] };
      setTasks(tasks);
    } catch {}
  }, []);

  const running = tasks.filter((t) => t.status === "running").length;
  useEffect(() => setRunningCount(running), [running]);

  useEffect(() => {
    void load();
    // 有在跑的就勤快点看，闲着就慢一点
    const t = setInterval(() => document.visibilityState === "visible" && load(), running ? 2500 : 8000);
    return () => clearInterval(t);
  }, [load, running]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => setNow(Date.now()), [tasks]);

  const has = tasks.length > 0;

  const toggle = (id: number) => setOpenId((cur) => (cur === id ? null : id));

  const list = () => (
    <ul className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain pr-0.5">
      <AnimatePresence initial={false}>
        {tasks.map((t) => (
          <Row key={t.id} t={t} now={now} open={openId === t.id} onToggle={() => toggle(t.id)} />
        ))}
      </AnimatePresence>
    </ul>
  );

  return (
    <>
      {/* 宽屏：常驻左边，列表自己滚 */}
      <aside className="fixed top-16 bottom-6 left-4 z-20 hidden w-[230px] flex-col xl:flex">
        <Balance />
        {has && (
          <>
            <div className="mb-2 shrink-0 px-2 text-xs tracking-wide text-[var(--faint)] select-none">任务</div>
            {list()}
          </>
        )}
      </aside>

      {/* 窄屏：左上角一个按钮，点开抽屉 */}
      {has && (
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="fixed top-4 left-4 z-20 flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)] xl:hidden"
          aria-label="任务"
        >
          {running ? <LoaderCircle size={18} strokeWidth={1.6} className="animate-spin" /> : <ListTodo size={18} strokeWidth={1.6} />}
        </button>
      )}
      <AnimatePresence>
        {drawer && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-30 bg-black/20 xl:hidden"
              onClick={() => setDrawer(false)}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", stiffness: 380, damping: 36 }}
              className="fixed top-0 bottom-0 left-0 z-30 flex w-[270px] flex-col border-r border-[var(--border)] bg-[var(--panel)] px-3 pt-5 pb-6 backdrop-blur-xl xl:hidden"
            >
              <Balance />
              <div className="mb-2 shrink-0 px-2 text-xs tracking-wide text-[var(--faint)] select-none">任务</div>
              {list()}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
