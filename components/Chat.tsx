"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, BookHeart, Moon, Phone, Sparkles, Sun } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import Mood from "./Mood";
import Starfield, { type Theme } from "./Starfield";
import { AttachmentStrip, useAttachments } from "./useAttachments";
import MicButton, { type VoiceSendResult } from "./VoiceRecorder";
import { hasSpeakable, VoiceButton, VoiceProvider, VoiceToggle } from "./Voice";

const MemoryMap = dynamic(() => import("./MemoryMap"), { ssr: false });
const Album = dynamic(() => import("./Album"), { ssr: false });
const Call = dynamic(() => import("./Call"), { ssr: false });

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
  previews?: string[];
  kind?: string;
  mood?: string;
};
type ServerMsg = { id: number; clientId: string | null; role: "user" | "assistant"; content: string; status: Status; createdAt: number; kind?: string };
type Outbox = { clientId: string; content: string; createdAt: number; images?: string[] };

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
const writeOutbox = (o: Outbox[]) => {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(o));
  } catch {
    // 图太大存不下：至少把文字存住
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(o.map(({ images: _, ...rest }) => rest)));
  }
};

/* ---------- Chrome 通知：页面在后台时弹，点一下跳回来 ---------- */
let swReg: ServiceWorkerRegistration | null = null;
let myName = "懂你";
const plain = (t: string) =>
  t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/[*_~`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
function browserNotify(id: number, text: string) {
  if (!document.hidden || !swReg || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  void swReg.showNotification(myName, { body: plain(text) || "给你发了条消息", tag: `msg-${id}` });
}
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
  const [micHint, setMicHint] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [showAlbum, setShowAlbum] = useState(false);
  const [calling, setCalling] = useState(false);
  const [memCount, setMemCount] = useState<number | null>(null);
  const [pulse, setPulse] = useState(0);
  const [theme, setTheme] = useState<Theme>("light");

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
            body: JSON.stringify({ clientId: item.clientId, content: item.content, images: item.images ?? [] }),
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
              } else if (e.type === "mood") {
                patch(aKey, (m) => ({ ...m, mood: e.mood }));
              } else if (e.type === "voice") {
                // 他说的是语音，她的回复也带了一条语音：接在正文后面
                patch(aKey, (m) => ({ ...m, content: `${m.content}\n\n${e.markdown}` }));
              } else if (e.type === "reset") {
                patch(aKey, (m) => ({ ...m, status: "waiting", content: "" }));
              } else if (e.type === "delta") {
                patch(aKey, (m) => ({ ...m, status: "streaming", content: m.content + e.text }));
              } else if (e.type === "done") {
                finished = true;
                patch(aKey, (m) => {
                  if (m.id) browserNotify(m.id, m.content);
                  return { ...m, status: "done" };
                });
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
      if (busy.current) return;
      const maxId = Math.max(0, ...msgsRef.current.map((m) => m.id ?? 0));
      try {
        const { messages } = (await (await fetch(`/api/messages?after=${maxId + 1}`)).json()) as { messages: ServerMsg[] };
        const known = new Set(msgsRef.current.map((m) => m.id));
        const fresh = messages.filter((m) => !known.has(m.id) && m.status === "done");
        if (!fresh.length || busy.current) return;
        stick.current = true;
        setMsgs((list) => [...list, ...fresh.map((m) => ({ ...fromServer(m), fresh: true }))]);
        fresh.filter((m) => m.role === "assistant" && m.kind !== "system").forEach((m) => browserNotify(m.id, m.content));
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [loaded]);

  useEffect(() => {
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("/sw.js")
        .then((r) => (swReg = r))
        .catch(() => {});
    const ping = async () => {
      const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
      try {
        const r = await (
          await fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ granted }) })
        ).json();
        if (r.name) myName = r.name;
      } catch {}
    };
    void ping();
    const t = setInterval(ping, 45_000);
    return () => clearInterval(t);
  }, []);

  const att = useAttachments();

  const send = useCallback(() => {
    const text = draft.trim();
    const images = att.items.map((a) => a.dataUrl);
    if (!text && !images.length) return;
    // 第一次发消息时顺手要一下通知权限（必须在用户操作里要）
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    const item: Outbox = { clientId: crypto.randomUUID(), content: text, createdAt: Date.now(), ...(images.length ? { images } : {}) };
    att.clear();
    writeOutbox([...readOutbox(), item]);
    setMsgs((list) => [
      ...list,
      {
        key: `c${item.clientId}`,
        clientId: item.clientId,
        role: "user",
        content: text,
        previews: images,
        status: "sending",
        createdAt: item.createdAt,
        fresh: true,
      },
    ]);
    setDraft("");
    localStorage.removeItem(DRAFT_KEY);
    stick.current = true;
    enqueue(item);
  }, [draft, enqueue, att]);

  /* ---------- 语音：服务端已经存好音频并听懂了，这里只把对话接上 ---------- */  const sendVoice = useCallback(
    (r: VoiceSendResult) => {
      if (!r.user) {
        setMicHint("这段没发出去，再说一遍？");
        return;
      }
      const u = r.user;
      const key = `c${u.clientId ?? u.id}`;
      setMsgs((list) => [
        ...list.filter((m) => m.key !== key),
        { key, clientId: u.clientId, id: u.id, role: "user", content: u.content, status: "done", createdAt: u.createdAt, fresh: true },
      ]);
      stick.current = true;
      if (r.reply) {
        const rep = r.reply;
        setMsgs((list) => [
          ...list,
          { key: `s${rep.id}`, id: rep.id, role: "assistant", content: rep.content, status: "done", createdAt: rep.createdAt, fresh: true },
        ]);
        return;
      }
      if (u.clientId) enqueue({ clientId: u.clientId, content: r.text ?? "", createdAt: u.createdAt });
    },
    [enqueue],
  );

  useEffect(() => {
    if (!micHint) return;
    const t = window.setTimeout(() => setMicHint(null), 4000);
    return () => window.clearTimeout(t);
  }, [micHint]);

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
        list.push({ key: `c${o.clientId}`, clientId: o.clientId, role: "user", content: o.content, previews: o.images, status: "sending", createdAt: o.createdAt });
      setMsgs(list);
      setHasMore(hasMore);
      setLoaded(true);
      // 没写完的回复（含之前出错的）服务端会自动重新生成，这里跟着拿结果
      for (const m of list) if (m.role === "assistant" && m.id && m.status !== "done") void follow(m.key, m.id);
      resend.forEach(enqueue);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (showMap || showAlbum) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1 || e.key === "Process") input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showMap, showAlbum]);

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
    <VoiceProvider>
    <div
      className="relative flex h-dvh flex-col overflow-hidden"
      onDragEnter={att.onDragEnter}
      onDragOver={att.onDragOver}
      onDragLeave={att.onDragLeave}
      onDrop={att.onDrop}
    >
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
      <button
        onClick={() => setCalling(true)}
        className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
        aria-label="打电话"
        title="打电话给她"
      >
        <Phone size={18} strokeWidth={1.6} />
      </button>
      <VoiceToggle />
      <button
        onClick={() => setShowAlbum(true)}
        className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
        aria-label="相册"
        title="相册和衣橱"
      >
        <BookHeart size={18} strokeWidth={1.6} />
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
                {showTime && <div className="my-6 text-center text-xs tracking-wide text-[var(--faint)] tabular-nums select-none">{timeLabel(m.createdAt)}</div>}
                <motion.div
                  initial={m.fresh ? { opacity: 0, y: m.role === "user" ? 14 : 6 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
                  className={m.role === "user" ? "mt-5 flex justify-end" : "mt-4"}
                >
                  {m.kind === "system" ? (
                    <div className="mx-auto line-clamp-2 max-w-[80%] text-center text-xs leading-relaxed text-[var(--faint)]" title={m.content}>
                      {m.content.replace(/[*`#]/g, "")}
                    </div>
                  ) : m.role === "user" ? (
                    <div className="flex max-w-[85%] items-center gap-2">
                      <div
                        className={`min-w-0 rounded-2xl rounded-br-md border border-[var(--bubble-border)] bg-[var(--bubble)] px-4 py-2.5 text-[15.5px] leading-[1.75] text-[var(--text)] shadow-[var(--bubble-shadow)] transition-opacity ${
                          m.status === "sending" ? "opacity-70" : ""
                        }`}
                      >
                        {!!m.previews?.length && (
                          <div className="md-imgs md-imgs-multi mb-1">
                            {m.previews.map((p, k) => (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={k} src={p} alt="" className="md-img" />
                            ))}
                          </div>
                        )}
                        {m.content && <Markdown text={m.content} animate={!!m.fresh} />}
                      </div>
                    </div>
                  ) : (
                    <div className="group min-w-0 text-[16px] text-[var(--text)]">
                      {m.status === "waiting" ? (
                        <Mood mood={m.mood} />
                      ) : (
                        <Markdown text={m.content} animate={m.status === "streaming" || !!m.fresh} voiceAuto={!!m.fresh} />
                      )}
                      {m.status === "done" && !!m.id && hasSpeakable(m.content) && !m.content.includes("/api/voice/clip/") && (
                        <div className="msg-actions">
                          <VoiceButton id={m.id} fresh={!!m.fresh && m.kind !== "call"} />
                        </div>
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
          {att.hint && <div className="mb-2 text-center text-xs text-[var(--faint)]">{att.hint}</div>}
          {micHint && <div className="mb-2 text-center text-xs text-[var(--faint)]">{micHint}</div>}
          <div
            className={`beam flex items-end gap-2 rounded-[26px] border bg-[var(--panel)] py-2 pr-2 pl-5 shadow-[var(--shadow)] backdrop-blur-xl transition-colors ${
              att.dragging ? "border-[var(--dot)]" : "border-[var(--border)]"
            }`}
          >
            <div className="min-w-0 flex-1 pt-1">
            <AttachmentStrip items={att.items} onRemove={att.remove} />
            <textarea
              onPaste={att.onPaste}
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
              className="scroll-thin block max-h-[40vh] w-full resize-none bg-transparent py-1 text-[16px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--faint)]"
            />
            </div>
            <MicButton onSent={sendVoice} onHint={setMicHint} />
            <AnimatePresence>
              {(draft.trim() || att.items.length > 0) && (
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
      <AnimatePresence>{showAlbum && <Album onClose={() => setShowAlbum(false)} />}</AnimatePresence>
      <AnimatePresence>{calling && <Call onClose={() => setCalling(false)} />}</AnimatePresence>
    </div>
    </VoiceProvider>
  );
}
