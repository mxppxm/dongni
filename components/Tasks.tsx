"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, ListTodo, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Task = {
  id: number;
  kind: string;
  title: string;
  status: "running" | "done" | "error";
  result: string;
  startedAt: number;
  endedAt: number | null;
};

const ago = (ts: number, now: number) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const took = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`);

const firstImage = (md: string) => md.match(/!\[[^\]]*\]\((\/api\/[^)\s]+)\)/)?.[1];
const filePath = (md: string) => {
  const m = md.match(/```card\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const c = JSON.parse(m[1]);
    return c.type === "file" ? (c.path as string) : null;
  } catch {
    return null;
  }
};

function Row({ t, now }: { t: Task; now: number }) {
  const [open, setOpen] = useState(false);
  const img = t.status === "done" ? firstImage(t.result) : undefined;
  const file = t.status === "done" ? filePath(t.result) : null;
  const note = t.status === "error" ? t.result : "";
  const more = !!(img || file || note);
  return (
    <motion.li layout initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3 }}>
      <button
        type="button"
        onClick={() => more && setOpen((o) => !o)}
        className={`flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left transition-colors ${more ? "hover:bg-[var(--hover)]" : "cursor-default"}`}
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
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden pl-7"
          >
            {img && (
              <a href={img} target="_blank" rel="noreferrer" className="mt-1 mb-2 block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img} alt="" className="max-h-40 rounded-lg border border-[var(--border)] object-cover" />
              </a>
            )}
            {file && (
              <button
                type="button"
                onClick={() => fetch("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file }) })}
                className="mt-0.5 mb-2 block max-w-full truncate text-left text-[12px] text-[var(--dim)] underline-offset-2 hover:underline"
                title={file}
              >
                {file.split("/").pop()}
              </button>
            )}
            {note && <div className="mt-0.5 mb-2 text-[12px] leading-relaxed break-words text-[var(--faint)]">{note}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

/** 左边的任务栏：她动手干的事一件件列着，跑着的转圈，画好的点开能看图 */
export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(async () => {
    try {
      const { tasks } = (await (await fetch("/api/tasks")).json()) as { tasks: Task[] };
      setTasks(tasks);
    } catch {}
  }, []);

  const running = tasks.filter((t) => t.status === "running").length;

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

  if (!tasks.length) return null;

  const list = (
    <ul className="space-y-0.5">
      <AnimatePresence initial={false}>
        {tasks.map((t) => (
          <Row key={t.id} t={t} now={now} />
        ))}
      </AnimatePresence>
    </ul>
  );

  return (
    <>
      {/* 宽屏：常驻左边 */}
      <aside className="scroll-thin fixed top-16 bottom-6 left-4 z-10 hidden w-[230px] overflow-y-auto xl:block">
        <div className="mb-2 px-2 text-xs tracking-wide text-[var(--faint)] select-none">任务</div>
        {list}
      </aside>

      {/* 窄屏：左上角一个按钮，点开抽屉 */}
      <button
        type="button"
        onClick={() => setDrawer(true)}
        className="fixed top-4 left-4 z-20 flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)] xl:hidden"
        aria-label="任务"
      >
        {running ? <LoaderCircle size={18} strokeWidth={1.6} className="animate-spin" /> : <ListTodo size={18} strokeWidth={1.6} />}
      </button>
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
              className="scroll-thin fixed top-0 bottom-0 left-0 z-30 w-[270px] overflow-y-auto border-r border-[var(--border)] bg-[var(--panel)] px-3 pt-5 pb-6 backdrop-blur-xl xl:hidden"
            >
              <div className="mb-2 px-2 text-xs tracking-wide text-[var(--faint)] select-none">任务</div>
              {list}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
