"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Dock from "./Dock";
import Markdown from "./Markdown";
import Mood from "./Mood";
import Starfield, { type Theme } from "./Starfield";
import { AttachmentStrip, useAttachments } from "./useAttachments";
import MicButton, { type VoiceSendResult } from "./VoiceRecorder";
import { setPageQuiet } from "./Voice";

/** 通话期间让页面别自己出声（语音消息条） */
function QuietWhile({ on }: { on: boolean }) {
  useEffect(() => {
    setPageQuiet(on);
    return () => setPageQuiet(false);
  }, [on]);
  return null;
}

const MemoryMap = dynamic(() => import("./MemoryMap"), { ssr: false });
const Album = dynamic(() => import("./Album"), { ssr: false });
const Call = dynamic(() => import("./Call"), { ssr: false });
const Tasks = dynamic(() => import("./Tasks"), { ssr: false });
const Plugins = dynamic(() => import("./Plugins"), { ssr: false });

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
const NOTIFY_KEY = "dongni:notify";

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

/* ---------- 系统通知：页面不在眼前时收到她的新消息才弹，点一下跳回来、跳到那条 ---------- */
let swReg: ServiceWorkerRegistration | null = null;
let myName = "懂你";
const plain = (t: string) =>
  t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\(([^)]*)\)/g, (_, f: string) => (isVoiceSrc(f) ? "[语音] " : "[图片] "))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const isVoiceSrc = (src: string) => src.startsWith("/api/voice/clip/");
/** 通知正文：最多 60 个字，后面提一句还有几条 */
const snippet = (text: string, more = 0) => {
  const body = [...(plain(text) || "给你发了条消息")];
  const cut = body.length > 60 ? [...body.slice(0, 60)].join("") + "…" : body.join("");
  return more > 0 ? `${cut}（还有 ${more} 条）` : cut;
};

// 权限：first 只试着要一次，他拒了就不再弹；每次打开问一遍，还关着就认作「不想被打扰」
const NOTIFY_DEFAULT = { state: "first", at: 0 };
function readNotifyPref() {
  try {
    return { ...NOTIFY_DEFAULT, ...JSON.parse(localStorage.getItem(NOTIFY_KEY) || "{}") };
  } catch {
    return { ...NOTIFY_DEFAULT };
  }
}
function writeNotifyPref(p: { state: string; at: number }) {
  try {
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(p));
  } catch {}
}
/** 要权限：only 传了，就只在他拒过的记录已被清掉时再要一次 */
function askNotify(only?: "first") {
  if (only === "first" && readNotifyPref().state !== "first") return;
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().then((p) => {
    // 新开页面时手上没有用户动作，浏览器直接答「拒绝」不算数，等他要发消息时再问
    if (p === "denied" && document.hasFocus()) writeNotifyPref({ state: "denied", at: Date.now() });
  });
}

const NOTIFY_GRACE = 600;
// 还没弹出去的新消息：ids 等着弹的，items 已经拿到正文的，timers 每条最多等多久
let notifyDraft = { ids: new Set<number>(), items: new Map<number, string>(), timers: new Map<number, number>(), timer: 0 };
const notifySeen = new Set<number>(); // 弹过的，绝不弹第二次
/** 一串新消息：攒几百毫秒合成一条；同一条只弹一次。正文还没写出来就用「N 条新消息」 */
function browserNotifySoon(ids: number[]) {
  for (const id of ids) {
    notifyDraft.ids.add(id);
    notifyDraft.timers.set(id, Date.now() + NOTIFY_GRACE);
  }
  if (!notifyDraft.timer) notifyDraft.timer = window.setTimeout(flushNotify, NOTIFY_GRACE);
}
/** 她这一条回完了：正文知道了，还没弹出去的通知用正文补上 */
function browserNotifyText(id: number, text: string) {
  if (notifySeen.has(id)) return;
  notifyDraft.items.set(id, text);
}
/** 攒着的消息：正文出来了就弹正文，等不到正文（比如打电话时说的）就数条数 */
function flushNotify() {
  notifyDraft.timer = 0;
  const now = Date.now();
  const fresh = [...notifyDraft.ids].filter((id) => !notifySeen.has(id)).sort((a, b) => a - b);
  const waiting = fresh.filter((id) => !notifyDraft.items.has(id) && now < (notifyDraft.timers.get(id) ?? 0));
  const ready = fresh.filter((id) => !waiting.includes(id));
  notifyDraft.ids = new Set(waiting);
  if (waiting.length) notifyDraft.timer = window.setTimeout(flushNotify, NOTIFY_GRACE);
  else notifyDraft = { ...notifyDraft, items: new Map(), timers: new Map() };
  if (!ready.length) return;
  ready.forEach((id) => notifySeen.add(id));
  const last = ready[ready.length - 1];
  const body = snippet(notifyDraft.items.get(last) ?? "", ready.length - 1);
  void showNotice(last, body);
}
async function showNotice(messageId: number | null, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !swReg) return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    await swReg.showNotification(myName, {
      body,
      tag: "dongni-message",
      data: { messageId },
      // 手机上没监听 body 的话条本身就点不了，直接把页面带回来
      ...({ clickAction: "/" } as Record<string, unknown>),
    });
  } catch {}
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
  const [showAbilities, setShowAbilities] = useState(false);
  const [calling, setCalling] = useState(false);
  const [callMini, setCallMini] = useState(false);
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
  const inflight = useRef(0); // 还在收回复的条数
  const composing = useRef(false);
  const memCountRef = useRef<number | null>(null);
  const focusMsg = useRef<number | null>(null); // 点了通知要跳过去的那条
  const hasMoreRef = useRef(false);
  hasMoreRef.current = hasMore;
  const revealNow = useRef<number | null>(null); // 正要跳过去的那条，一次只跳一条
  const revealRef = useRef<(id: number) => void>(() => {});

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
          // 这条被并进后面那句一起回了：占位收掉
          if (!m) return setMsgs((list) => list.filter((x) => x.key !== key));
          patch(key, (old) => ({ ...old, content: m.content, status: m.content || m.status === "done" ? m.status : "waiting" }));
          if (m.status === "done") return;
        } catch {}
      }
    },
    [patch],
  );

  /* ---------- 发送队列：一条一条发，先进先出；连不上就一直重试 ---------- */
  const deliver = useCallback(
    async (item: Outbox, onInserted: () => void = () => {}) => {
      inflight.current++;
      try {
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
                  onInserted();
                  writeOutbox(readOutbox().filter((o) => o.clientId !== item.clientId));
                  patch(uKey, (m) => ({ ...m, id: e.userId, status: "done" }));
                  patch(aKey, (m) => ({ ...m, id: e.assistantId }));
                } else if (e.type === "mood") {
                  patch(aKey, (m) => ({ ...m, mood: e.mood }));
                } else if (e.type === "voice") {
                  // 他说的是语音，她的回复也带了一条语音：接在正文后面
                  patch(aKey, (m) => ({ ...m, content: `${m.content}\n\n${e.markdown}` }));
                } else if (e.type === "merged") {
                  // 和后面紧跟着的话合成一句回了：这条的占位收掉，回复在合并的那条里
                  finished = true;
                  setMsgs((list) => list.filter((m) => m.key !== aKey));
                } else if (e.type === "reset") {
                  patch(aKey, (m) => ({ ...m, status: "waiting", content: "" }));
                } else if (e.type === "delta") {
                  patch(aKey, (m) => ({ ...m, status: "streaming", content: m.content + e.text }));
                } else if (e.type === "done") {
                  finished = true;
                  patch(aKey, (m) => {
                    if (m.id) browserNotifyText(m.id, m.content);
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
      } finally {
        inflight.current--;
      }
    },
    [patch, follow, checkMemories],
  );

  // 按顺序一条条送进库就行，不等她回完：连着说的几句她才能合在一起回
  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length) {
      const item = queue.current[0];
      await new Promise<void>((inserted) => void deliver(item, inserted).finally(inserted));
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

  /* ---------- 同步整场对话：电话里说的、她主动发的、提醒、改好了……都从这里进来 ---------- */
  // 一条路：页面不只看自己发出去的那几句，库里这场对话有什么就显示什么（在生成的也边写边显示）
  const msgsRef = useRef<Msg[]>([]);
  msgsRef.current = msgs;
  const callingRef = useRef(false);
  callingRef.current = calling;
  useEffect(() => {
    if (!loaded) return;
    let stop = false;
    let timer: number | undefined;
    const sync = async () => {
      const list = msgsRef.current;
      const maxId = Math.max(0, ...list.map((m) => m.id ?? 0));
      try {
        // 往回多看一段：页面后来拿到的编号可能比还在生成的电话消息大，别把它们漏了
        const { messages } = (await (await fetch(`/api/messages?after=${Math.max(0, maxId - 40)}`)).json()) as { messages: ServerMsg[] };
        const byId = new Map(msgsRef.current.filter((m) => m.id).map((m) => [m.id!, m]));
        const byClient = new Map(msgsRef.current.filter((m) => m.clientId).map((m) => [m.clientId!, m]));
        const added: Msg[] = [];
        const updates = new Map<string, Partial<Msg>>();
        for (const sm of messages) {
          const status: Status = sm.status === "streaming" && !sm.content ? "waiting" : sm.status;
          const mine = byId.get(sm.id) ?? (sm.clientId ? byClient.get(sm.clientId) : undefined);
          if (mine) {
            // 自己正在收流的那条由发送那边管；收完了（或者是别的口子来的）以库里为准
            const owned = mine.key.startsWith("a") && mine.status !== "done";
            if (!owned && (mine.content !== sm.content || mine.status !== status || mine.kind !== sm.kind || !mine.id))
              updates.set(mine.key, { id: sm.id, content: sm.content, status, kind: sm.kind });
            continue;
          }
          // 正在发的那句，回复占位还没对上编号：先不认，免得同一条出现两次
          const sending = busy.current || inflight.current > 0;
          if (sending && sm.role === "assistant" && sm.kind !== "call" && sm.status !== "done") continue;
          if (sending && sm.role === "user" && sm.kind !== "call") continue;
          added.push({ ...fromServer(sm), status, fresh: true });
        }
        // 库里没了的回复占位（并进后面那句一起回了）：页面上也收掉；自己正在收流的那条由发送那边管
        const from = Math.max(0, maxId - 40);
        const there = new Set(messages.map((m) => m.id));
        const gone = new Set(
          msgsRef.current
            .filter((m) => m.id && m.id >= from && m.role === "assistant" && m.status !== "done" && !m.key.startsWith("a") && !there.has(m.id))
            .map((m) => m.key),
        );
        if (gone.size) setMsgs((cur) => cur.filter((m) => !gone.has(m.key)));
        if (!added.length && !updates.size) return;
        stick.current = stick.current || added.length > 0;
        setMsgs((cur) => {
          let next = updates.size ? cur.map((m) => (updates.has(m.key) ? { ...m, ...updates.get(m.key) } : m)) : cur;
          const have = new Set(next.map((m) => m.id).filter(Boolean));
          for (const a of added) {
            if (have.has(a.id)) continue;
            // 按编号插到该在的位置；还没编号的（正在发的）留在最后
            const at = next.findIndex((m) => !m.id || m.id > a.id!);
            next = at < 0 ? [...next, a] : [...next.slice(0, at), a, ...next.slice(at)];
          }
          return next;
        });
        // 新到的她的消息：页面不在眼前就弹通知；一次都还没弹过权限的，这时顺手要一次
        const arrived = added.filter((m) => m.role === "assistant" && m.kind !== "system" && m.status === "done" && m.id);
        if (arrived.length) {
          askNotify("first");
          for (const m of arrived) browserNotifyText(m.id!, m.content);
          browserNotifySoon(arrived.map((m) => m.id!));
        }
      } catch {}
    };
    const loop = async () => {
      if (stop) return;
      // 页面切到后台也照样同步（慢一点）：后台的活做完了，得靠这里拿到新消息才弹得出浏览器通知
      await sync();
      // 通话中勤快点，电话里说的话几乎实时出现在对话框
      // 不在眼前时要跟着：她主动发的、打电话时说的、提醒、后台的活做完了，都得靠这里拿来才弹得出通知
      timer = window.setTimeout(loop, callingRef.current ? 1000 : document.visibilityState === "visible" && document.hasFocus() ? 4000 : 2500);
    };
    void loop();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
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
          await fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ granted, visible: document.visibilityState === "visible" }) })
        ).json();
        if (r.name) myName = r.name;
      } catch {}
    };
    void ping();
    // 窗口也失焦（切到别的应用）时照样报到，服务端才知道他不在跟前
    const t = setInterval(() => document.visibilityState === "visible" && void ping(), 45_000);
    // 切回来马上报到：他不在时攒着的话，回来就该说了
    const onVis = () => document.visibilityState === "visible" && void ping();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    // 注册好、页面也加载完了，试着要一次通知权限（拒绝过的不再问）
    if (loaded) askNotify("first");
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [loaded]);

  /* ---------- 点通知：跳回页面、回到那条消息 ---------- */
  // 通知交给页面里的这里处理（没开着就让后台的 service worker 直接打开页面，打开后再说一声）
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "dongni-notify-open") return;
      const id = Number(e.data.messageId);
      if (Number.isFinite(id) && id > 0) void revealRef.current(id);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // 顺着往上翻，直到找到那条（翻到一半也没有就算了）
  const loadUntil = useCallback(
    async (id: number) => {
      for (let i = 0; i < 50; i++) {
        let more = true;
        let firstId = 0;
        setMsgs((list) => {
          more = hasMoreRef.current;
          firstId = list.find((m) => m.id)?.id ?? 0;
          return list;
        });
        if (!more || !firstId || firstId <= id) return;
        try {
          const { messages, hasMore: more2 } = (await (await fetch(`/api/messages?before=${firstId}&limit=60`)).json()) as { messages: ServerMsg[]; hasMore: boolean };
          setHasMore(more2);
          hasMoreRef.current = more2;
          setMsgs((list) => {
            const have = new Set(list.map((m) => m.id));
            const front = messages.filter((m) => !have.has(m.id)).map(fromServer);
            return front.length ? [...front, ...list] : list;
          });
        } catch {
          return;
        }
        await new Promise((r) => setTimeout(r, 80));
      }
    },
    [],
  );
  const reveal = useCallback(
    async (id: number) => {
      revealNow.current = id;
      await loadUntil(id);
      let hit = false;
      setMsgs((list) => {
        hit = list.some((m) => m.id === id && m.role === "assistant" && m.status === "done");
        return list;
      });
      if (!hit) return;
      if (revealNow.current !== id) return;
      revealNow.current = null;
      // 翻完了：挂上记号，等这一帧画出来再滚过去（页面上会把它带出来）
      focusMsg.current = id;
      setMsgs((list) => [...list]);
    },
    [loadUntil],
  );
  revealRef.current = reveal;

  const att = useAttachments();

  const send = useCallback(() => {
    const text = draft.trim();
    const images = att.items.map((a) => a.dataUrl);
    if (!text && !images.length) return;
    // 第一次发消息时顺手要一下通知权限（必须在用户操作里要）；他刚在浏览器里重新允许了就再试一次
    if (typeof Notification !== "undefined" && Notification.permission === "default" && readNotifyPref().state !== "first") writeNotifyPref(NOTIFY_DEFAULT);
    askNotify("first");
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
      // 打开页面之前就有的不弹通知；加载完才到的才算新消息
      for (const m of messages) if (m.id) notifySeen.add(m.id);
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
      // 从通知里点进来（页面是它新开的）：跳到他点的那条
      const want = Number(new URLSearchParams(location.search).get("msg"));
      if (Number.isFinite(want) && want > 0) {
        history.replaceState(null, "", location.pathname);
        void revealRef.current(want);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 往上翻历史 ---------- */
  const fetchOlder = useCallback(
    (before: number) => fetch(`/api/messages?before=${before}&limit=60`).then((r) => r.json() as Promise<{ messages: ServerMsg[]; hasMore: boolean }>),
    [],
  );
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || revealNow.current !== null) return;
    const first = msgs.find((m) => m.id)?.id;
    if (!first) return;
    loadingOlder.current = true;
    try {
      const { messages, hasMore: more } = await fetchOlder(first);
      const el = scroller.current!;
      restore.current = { h: el.scrollHeight, top: el.scrollTop };
      setMsgs((list) => [...messages.map(fromServer), ...list]);
      setHasMore(more);
    } finally {
      loadingOlder.current = false;
    }
  }, [msgs, hasMore, fetchOlder]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (focusMsg.current !== null) {
      // 点了通知跳过来的：这一帧别粘到底，也先别按翻历史的位置还原，直接看那条
      const id = focusMsg.current;
      focusMsg.current = null;
      restore.current = null;
      el.querySelector<HTMLElement>(`[data-mid="${id}"]`)?.scrollIntoView({ block: "center" });
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      return;
    }
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
      if (showMap || showAlbum || showAbilities) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1 || e.key === "Process") input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showMap, showAlbum, showAbilities]);

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
    <div
      className="relative flex h-dvh flex-col overflow-hidden"
      onDragEnter={att.onDragEnter}
      onDragOver={att.onDragOver}
      onDragLeave={att.onDragLeave}
      onDrop={att.onDrop}
    >
      <div className="pointer-events-none fixed inset-0 bg-[image:var(--glow-bg)]" />
      <Starfield pulse={pulse} theme={theme} />
      <Tasks />
      <QuietWhile on={calling} />

      <Dock
        theme={theme}
        onToggleTheme={toggleTheme}
        calling={calling}
        onCall={() => (calling ? setCallMini(false) : (setCallMini(false), setCalling(true)))}
        onMap={() => setShowMap(true)}
        onAlbum={() => setShowAlbum(true)}
        onAbilities={() => setShowAbilities(true)}
        memCount={memCount}
        pulse={pulse}
      />

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
                  data-mid={m.id}
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
            <MicButton onSent={sendVoice} onHint={setMicHint} onIntercept={calling ? () => setCallMini(false) : undefined} />
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
      <AnimatePresence>{showAbilities && <Plugins onClose={() => setShowAbilities(false)} />}</AnimatePresence>
      <AnimatePresence>{calling && <Call mini={callMini} onMini={setCallMini} onClose={() => setCalling(false)} />}</AnimatePresence>
    </div>
  );
}
