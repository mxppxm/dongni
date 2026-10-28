"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Moon, Sparkles, Sun } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import ReminderToast from "./ReminderToast";
import Starfield, { type Theme } from "./Starfield";

const MemoryMap = dynamic(() => import("./MemoryMap"), { ssr: false });

type Status = "done" | "streaming" | "error" | "sending" | "waiting";
type Msg = {
  key: string;
  id?: number;
  clientId?: string | null;
  role: "user" | "assistant";
  content: string;
  status: Status;
  createdAt: number;
  fresh?: boolean;
  tool?: string;
};
type ServerMsg = { id: number; clientId: string | null; role: "user" | "assistant"; content: string; status: Status; createdAt: number };
type Outbox = { clientId: string; content: string; createdAt: number };

const DRAFT_KEY = "dongni:draft";
const THEME_KEY = "dongni:theme";
const OUTBOX_KEY = "dongni:outbox";

const readOutbox = (): Outbox[] => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
  } catch {
    return [];
  }
};
const writeOutbox = (o: Outbox[]) => localStorage.setItem(OUTBOX_KEY, JSON.stringify(o));
const fromServer = (m: ServerMsg): Msg => ({ ...m, key: `s${m.id}` });

function timeLabel(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return hm;
  if (diff === 1) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export default function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [showMap, setShowMap] = useState(false);
  const [memCount, setMemCount] = useState<number | null>(null);
  const [pulse, setPulse] = useState(0);
  const [theme, setTheme] = useState<Theme>("light");
  const [reminder, setReminder] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  };

  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const restore = useRef<{ h: number; top: number } | null>(null);
  const loadingOlder = useRef(false);
  const queue = useRef<Outbox[]>([]);
  const busy = useRef(false);
  const composing = useRef(false);
  const memCountRef = useRef<number | null>(null);

  const patch = useCallback((key: string, fn: (m: Msg) => Msg) => {
    setMsgs((list) => list.map((m) => (m.key === key ? fn(m) : m)));
  }, []);

  /* ---------- 记忆数：有新记忆时让星星亮一下 ---------- */
  const checkMemories = useCallback(async () => {
    try {
      const { count } = await (await fetch("/api/memories?count=1")).json();
      if (memCountRef.current !== null && count > memCountRef.current) setPulse((p) => p + 1);
      memCountRef.current = count;
      setMemCount(count);
    } catch {}
  }, []);

  useEffect(() => {
    checkMemories();
    const t = setInterval(() => document.visibilityState === "visible" && checkMemories(), 8000);
    return () => clearInterval(t);
  }, [checkMemories]);

  /* ---------- 断线后追回复：回复在服务端照常写库，这里轮询拿结果 ---------- */
  const follow = useCallback(
    async (key: string, assistantId: number) => {
      // 一直跟到写完为止；服务重启期间请求失败也照样等
      for (;;) {
        await new Promise((r) => setTimeout(r, 900));
        try {
          const { messages } = (await (await fetch(`/api/messages?after=${assistantId}`)).json()) as { messages: ServerMsg[] };
          const m = messages.find((x) => x.id === assistantId);
          if (!m) return;
          patch(key, (old) => ({ ...old, content: m.content, status: m.content || m.status === "done" ? m.status : "waiting" }));
          if (m.status === "done") return;
        } catch {}
      }
    },
    [patch],
  );

  /* ---------- 发送队列：一条一条发，先进先出；连不上就一直重试 ---------- */
  const deliver = useCallback(
    async (item: Outbox) => {
      const uKey = `c${item.clientId}`;
      const aKey = `a${item.clientId}`;
      patch(uKey, (m) => ({ ...m, status: "sending" }));
      setMsgs((list) => [
        ...list.filter((m) => m.key !== aKey),
        { key: aKey, role: "assistant", content: "", status: "waiting", createdAt: Date.now(), fresh: true },
      ]);
      stick.current = true;

      for (let attempt = 0; ; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** (attempt - 1))));
        let assistantId = 0;
        let finished = false;
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId: item.clientId, content: item.content }),
          });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              if (!line) continue;
              const e = JSON.parse(line);
              if (e.type === "meta") {
                assistantId = e.assistantId;
                writeOutbox(readOutbox().filter((o) => o.clientId !== item.clientId));
                patch(uKey, (m) => ({ ...m, id: e.userId, status: "done" }));
                patch(aKey, (m) => ({ ...m, id: e.assistantId }));
              } else if (e.type === "tool") {
                patch(aKey, (m) => ({ ...m, tool: e.label }));
              } else if (e.type === "reset") {
                patch(aKey, (m) => ({ ...m, status: "waiting", content: "", tool: undefined }));
              } else if (e.type === "delta") {
                patch(aKey, (m) => ({ ...m, status: "streaming", tool: undefined, content: m.content + e.text }));
              } else if (e.type === "done") {
                finished = true;
                patch(aKey, (m) => ({ ...m, status: "done", tool: undefined }));
                [6000, 15000, 30000].forEach((ms) => setTimeout(checkMemories, ms));
              }
            }
          }
        } catch {}
        if (finished) return;
        if (assistantId) {
          // 已经落库，服务端会一直写到完成，这里跟着拿结果
          await follow(aKey, assistantId);
          [6000, 15000, 30000].forEach((ms) => setTimeout(checkMemories, ms));
          return;
        }
      }
    },
    [patch, follow, checkMemories],
  );

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length) {
      await deliver(queue.current[0]);
      queue.current.shift();
    }
    busy.current = false;
  }, [deliver]);

  const enqueue = useCallback(
    (item: Outbox) => {
      queue.current.push(item);
      void pump();
    },
    [pump],
  );

  /* ---------- 它主动发来的消息（比如改完自己的代码） ---------- */
  const msgsRef = useRef<Msg[]>([]);
  msgsRef.current = msgs;
  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(async () => {
      if (busy.current || document.visibilityState !== "visible") return;
      const maxId = Math.max(0, ...msgsRef.current.map((m) => m.id ?? 0));
      try {
        const { messages } = (await (await fetch(`/api/messages?after=${maxId + 1}`)).json()) as { messages: ServerMsg[] };
        const known = new Set(msgsRef.current.map((m) => m.id));
        const fresh = messages.filter((m) => !known.has(m.id) && m.status === "done");
        if (!fresh.length || busy.current) return;
        stick.current = true;
        setMsgs((list) => [...list, ...fresh.map((m) => ({ ...fromServer(m), fresh: true }))]);
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [loaded]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const item: Outbox = { clientId: crypto.randomUUID(), content: text, createdAt: Date.now() };
    writeOutbox([...readOutbox(), item]);
    setMsgs((list) => [
      ...list,
      { key: `c${item.clientId}`, clientId: item.clientId, role: "user", content: text, status: "sending", createdAt: item.createdAt, fresh: true },
    ]);
    setDraft("");
    localStorage.removeItem(DRAFT_KEY);
    stick.current = true;
    enqueue(item);
  }, [draft, enqueue]);

  /* ---------- 初次加载 + 补发没送达的 ---------- */
  useEffect(() => {
    setDraft(localStorage.getItem(DRAFT_KEY) || "");
    (async () => {
      const { messages, hasMore } = (await (await fetch("/api/messages?limit=60")).json()) as { messages: ServerMsg[]; hasMore: boolean };
      const list = messages.map(fromServer);
      const known = new Set(messages.map((m) => m.clientId).filter(Boolean));
      const outbox = readOutbox();
      writeOutbox(outbox.filter((o) => !known.has(o.clientId)));
      const resend = outbox.filter((o) => !known.has(o.clientId));
      for (const o of resend)
        list.push({ key: `c${o.clientId}`, clientId: o.clientId, role: "user", content: o.content, status: "sending", createdAt: o.createdAt });
      setMsgs(list);
      setHasMore(hasMore);
      setLoaded(true);
      // 没写完的回复（含之前出错的）服务端会自动重新生成，这里跟着拿结果
      for (const m of list) if (m.role === "assistant" && m.id && m.status !== "done") void follow(m.key, m.id);
      resend.forEach(enqueue);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 到点的提醒：轮询，弹一张小卡片（弹过的记着，不重复弹） ---------- */
  const seenReminders = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const { fired } = (await (await fetch("/api/reminders")).json()) as {
          fired: { id: number; text: string; firedAt: number | null }[];
        };
        if (stopped) return;
        // 第一次只把早就不新的标记成已弹，刚触发的照样弹
        seenReminders.current ??= new Set(fired.filter((r) => Date.now() - (r.firedAt ?? 0) > 90_000).map((r) => r.id));
        const unseen = fired.filter((r) => !seenReminders.current!.has(r.id));
        if (!unseen.length) return;
        unseen.forEach((r) => seenReminders.current!.add(r.id));
        setReminder({ id: unseen[unseen.length - 1].id, text: unseen[unseen.length - 1].text });
      } catch {}
    };
    void check();
    const t = setInterval(check, 5000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [loaded]);

  /* ---------- 往上翻历史 ---------- */
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore) return;
    const first = msgs.find((m) => m.id);
    if (!first) return;
    loadingOlder.current = true;
    try {
      const { messages, hasMore: more } = (await (await fetch(`/api/messages?before=${first.id}&limit=60`)).json()) as {
        messages: ServerMsg[];
        hasMore: boolean;
      };
      const el = scroller.current!;
      restore.current = { h: el.scrollHeight, top: el.scrollTop };
      setMsgs((list) => [...messages.map(fromServer), ...list]);
      setHasMore(more);
    } finally {
      loadingOlder.current = false;
    }
  }, [msgs, hasMore]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current) {
      el.scrollTop = el.scrollHeight - restore.current.h + restore.current.top;
      restore.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgs]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 300) void loadOlder();
  };

  /* ---------- 输入 ---------- */
  useEffect(() => {
    const ta = input.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + "px";
  }, [draft]);

  useEffect(() => {
    // 在页面任何地方直接打字就进输入框
    const onKey = (e: KeyboardEvent) => {
      if (showMap) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1 || e.key === "Process") input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showMap]);

  useEffect(() => {
    if (loaded && !showMap) input.current?.focus();
  }, [loaded, showMap]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send();
  };


  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <div className="pointer-events-none fixed inset-0 bg-[image:var(--glow-bg)]" />
      <Starfield pulse={pulse} theme={theme} />

      <div className="fixed top-4 right-4 z-20 flex gap-1">
      <button
        onClick={toggleTheme}
        className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
        aria-label="切换主题"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={theme}
            initial={{ rotate: -90, scale: 0.5, opacity: 0 }}
            animate={{ rotate: 0, scale: 1, opacity: 1 }}
            exit={{ rotate: 90, scale: 0.5, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="flex"
          >
            {theme === "dark" ? <Sun size={18} strokeWidth={1.6} /> : <Moon size={18} strokeWidth={1.6} />}
          </motion.span>
        </AnimatePresence>
      </button>
      <motion.button
        key={pulse}
        onClick={() => setShowMap(true)}
        initial={pulse ? { scale: 1.35, boxShadow: "0 0 28px 6px rgba(58,215,255,.55)" } : false}
        animate={{ scale: 1, boxShadow: "0 0 0px 0px rgba(58,215,255,0)" }}
        transition={{ duration: 1.4, ease: "easeOut" }}
        className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
        aria-label="记忆"
        title={memCount !== null ? `${memCount} 条记忆` : "记忆"}
      >
        <Sparkles size={18} strokeWidth={1.6} />
      </motion.button>
      </div>

      <div ref={scroller} onScroll={onScroll} className="scroll-thin relative z-10 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-5 pt-16 pb-44">
          {msgs.map((m, i) => {
            const prev = msgs[i - 1];
            const showTime = !prev || m.createdAt - prev.createdAt > 3600_000;
            return (
              <div key={m.key}>
                {showTime && <div className="my-6 text-center text-xs text-[var(--faint)] select-none">{timeLabel(m.createdAt)}</div>}
                <motion.div
                  initial={m.fresh ? { opacity: 0, y: m.role === "user" ? 14 : 6 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
                  className={m.role === "user" ? "mt-5 flex justify-end" : "mt-4"}
                >
                  {m.role === "user" ? (
                    <div className="flex max-w-[85%] items-center gap-2">
                      <div
                        className={`min-w-0 rounded-2xl rounded-br-md border border-[var(--bubble-border)] bg-[var(--bubble)] px-4 py-2.5 text-[15px] leading-relaxed text-[var(--text)] shadow-[var(--bubble-shadow)] transition-opacity ${
                          m.status === "sending" ? "opacity-70" : ""
                        }`}
                      >
                        <Markdown text={m.content} animate={!!m.fresh} />
                      </div>
                    </div>
                  ) : (
                    <div className="min-w-0 text-[16px] leading-[1.85] text-[var(--text)]">
                      {m.status === "waiting" ? (
                        <span className="inline-flex items-center gap-2.5">
                          <span className="breathe inline-block h-2 w-2 rounded-full bg-[var(--dot)] shadow-[0_0_12px_var(--dot)]" />
                          {m.tool && <span className="text-[13px] text-[var(--faint)]">{m.tool}…</span>}
                        </span>
                      ) : (
                        <Markdown text={m.content} animate={m.status === "streaming" || !!m.fresh} />
                      )}
                      {m.status === "streaming" && m.tool && (
                        <span className="mt-1 flex items-center gap-2.5 text-[13px] text-[var(--faint)]">
                          <span className="breathe inline-block h-1.5 w-1.5 rounded-full bg-[var(--dot)]" />
                          {m.tool}…
                        </span>
                      )}
                    </div>
                  )}
                </motion.div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 bg-[linear-gradient(to_top,var(--bg)_0%,var(--bg-85)_45%,transparent_100%)] pt-16 pb-6">
        <div className="pointer-events-auto mx-auto w-full max-w-[680px] px-5">
          <div className="beam flex items-end gap-2 rounded-[26px] border border-[var(--border)] bg-[var(--panel)] py-2 pr-2 pl-5 shadow-[var(--shadow)] backdrop-blur-xl">
            <textarea
              ref={input}
              value={draft}
              rows={1}
              onChange={(e) => {
                setDraft(e.target.value);
                localStorage.setItem(DRAFT_KEY, e.target.value);
              }}
              onKeyDown={onKeyDown}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              placeholder="说点什么…"
              className="scroll-thin max-h-[40vh] flex-1 resize-none bg-transparent py-2 text-[16px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--faint)]"
            />
            <AnimatePresence>
              {draft.trim() && (
                <motion.button
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 28 }}
                  onClick={send}
                  className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[image:var(--send)] text-[var(--send-fg)] shadow-[var(--send-glow)]"
                  aria-label="发送"
                >
                  <ArrowUp size={18} strokeWidth={2.4} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <AnimatePresence>{showMap && <MemoryMap theme={theme} onClose={() => setShowMap(false)} />}</AnimatePresence>

      <ReminderToast reminder={reminder} onClose={() => setReminder(null)} />
    </div>
  );
}
