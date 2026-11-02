"use client";

import { Loader2, Pause, Play, Volume2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * 念出来：一条回复一个小按钮，默认不自动念（设置里可以开）。
 * 切到别的消息会先停上一条。
 *
 * 「发不出声」的病根是：以前先把音频下完（fetch → blob → 换 src）、隔了一两秒才 play()，
 * 这时候浏览器已经不认那次点击了，Safari 直接拦掉；被拦了还当成「没生成出来」。
 * 现在一律把播放地址直接交给 audio 元素，并且在同一次点击里立刻 play()——不隔任何 await；
 * 浏览器真拦下来（自动念的时候页面还没拿到过手势）就摆「点一下播放」，音频不用重新合成。
 */
const AUTO_KEY = "dongni:voiceAuto";

type Phase = "idle" | "loading" | "playing" | "paused";
type Status = { id: number | null; phase: Phase };
/** synth：没生成出来（服务端失败/解码失败）；blocked：音频已经好了，被浏览器拦着不让自动播；pre：还没播就先判定会被拦 */
type Trouble = { id: number; kind: "synth" | "blocked"; pre?: boolean } | null;

type VoiceCtxValue = {
  autoplay: boolean;
  setAutoplay: (v: boolean) => void;
  status: Status;
  trouble: Trouble;
  toggle: (id: number) => void;
  retry: (id: number, kind: "synth" | "blocked") => void;
  auto: (id: number) => void;
  /** 打电话的时候：页面自己不出声（电话里她已经在说了），手动点的照常播 */
  setQuiet: (v: boolean) => void;
  quietRef: React.RefObject<boolean>;
};

const VoiceCtx = createContext<VoiceCtxValue | null>(null);

const isBlocked = (e: unknown) => (e as { name?: string } | null)?.name === "NotAllowedError";

/**
 * 页面到现在为止有没有拿到过用户手势。没拿到，浏览器一定不让页面自己出声（Chrome、Safari 都一样）。
 * 判断不了的旧浏览器返回 true：照常试一遍，被拦了下面还有 NotAllowedError 那条路兜着。
 */
function hasGesture() {
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean; isActive?: boolean } })
    .userActivation;
  if (!ua) return true;
  return !!(ua.hasBeenActive || ua.isActive);
}

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const [autoplay, setAutoplayState] = useState(false);
  const [status, setStatus] = useState<Status>({ id: null, phase: "idle" });
  const [trouble, setTrouble] = useState<Trouble>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const autoOn = useRef(false);
  const quietRef = useRef(false);

  useEffect(() => {
    // 默认开：只有他手动关过（存了 "0"）才不自动念
    const on = localStorage.getItem(AUTO_KEY) !== "0";
    autoOn.current = on;
    setAutoplayState(on);
  }, []);

  const stop = useCallback(() => {
    const a = audio.current;
    audio.current = null;
    if (a) {
      a.onended = null;
      a.onerror = null;
      a.pause();
      a.removeAttribute("src");
    }
    setStatus({ id: null, phase: "idle" });
  }, []);

  useEffect(() => () => stop(), [stop]);

  const play = useCallback(
    (id: number, gesture = false) => {
      stop();
      setTrouble(null);
      // 自动念的时候页面还没拿到过手势：别再硬播留一条静默失败，直接摆「点一下播放」
      if (!gesture && !hasGesture()) {
        setTrouble({ id, kind: "blocked", pre: true });
        return;
      }
      const a = new Audio();
      audio.current = a;
      a.preload = "auto";
      a.src = `/api/voice/${id}`;
      a.onended = () => setStatus({ id, phase: "idle" });
      a.onerror = () => {
        setStatus({ id: null, phase: "idle" });
        setTrouble({ id, kind: "synth" });
      };
      setStatus({ id, phase: "loading" });
      // 同一个手势里立刻播：浏览器允许；等下载完再播就会被当成自动播放拦掉
      a.play()
        .then(() => setStatus({ id, phase: "playing" }))
        .catch((e) => {
          setStatus({ id: null, phase: "idle" });
          setTrouble({ id, kind: isBlocked(e) ? "blocked" : "synth" });
        });
    },
    [stop],
  );

  /** 被浏览器拦下来的那条，音频地址还在：点一下接着播，不重新合成 */
  const retry = useCallback(
    (id: number, kind: "synth" | "blocked") => {
      const a = audio.current;
      if (kind === "blocked" && a && a.getAttribute("src")) {
        setStatus({ id, phase: "playing" });
        void a
          .play()
          .then(() => setTrouble(null))
          .catch((e) => {
            setStatus({ id: null, phase: "idle" });
            setTrouble({ id, kind: isBlocked(e) ? "blocked" : "synth" });
          });
        return;
      }
      play(id, true);
    },
    [play],
  );

  const toggle = useCallback(
    (id: number) => {
      const a = audio.current;
      if (a && status.id === id) {
        if (status.phase === "playing") {
          a.pause();
          setStatus({ id, phase: "paused" });
          return;
        }
        if (status.phase === "paused") {
          void a
            .play()
            .then(() => setStatus({ id, phase: "playing" }))
            .catch((e) => {
              setStatus({ id: null, phase: "idle" });
              setTrouble({ id, kind: isBlocked(e) ? "blocked" : "synth" });
            });
          return;
        }
        if (status.phase === "loading") return;
      }
      play(id, true);
    },
    [status, play],
  );

  const auto = useCallback(
    (id: number) => {
      if (autoOn.current && !quietRef.current) play(id);
    },
    [play],
  );

  const setAutoplay = useCallback(
    (v: boolean) => {
      localStorage.setItem(AUTO_KEY, v ? "1" : "0");
      autoOn.current = v;
      setAutoplayState(v);
      if (!v) {
        stop();
        setTrouble(null);
      }
    },
    [stop],
  );

  const setQuiet = useCallback(
    (v: boolean) => {
      quietRef.current = v;
      // 电话接起来：正在自动念的那条停掉，免得两个声音
      if (v) {
        stop();
        document.dispatchEvent(new Event("dongni:quiet"));
      }
    },
    [stop],
  );

  const value = useMemo<VoiceCtxValue>(
    () => ({ autoplay, setAutoplay, status, trouble, toggle, retry, auto, setQuiet, quietRef }),
    [autoplay, setAutoplay, status, trouble, toggle, retry, auto, setQuiet],
  );

  return <VoiceCtx.Provider value={value}>{children}</VoiceCtx.Provider>;
}

export function useVoice() {
  const v = useContext(VoiceCtx);
  if (!v) throw new Error("VoiceProvider 没套上");
  return v;
}

/** 有没有能念的字（纯图、纯代码、纯语音的消息不显示按钮） */
export function hasSpeakable(text: string) {
  const t = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[*_~`#>|:-]/g, "")
    .replace(/\s+/g, "");
  return t.length > 0;
}

/** 每条回复旁边那个很小的播放按钮：平时几乎看不见，鼠标移上去才亮出来 */
export function VoiceButton({ id, fresh }: { id: number; fresh?: boolean }) {
  const { status, trouble, toggle, retry, auto } = useVoice();
  // 开了「自动念出来」：这条刚来的时候念一遍；浏览器拦了会在这条旁边留「点一下再播」
  useEffect(() => {
    if (fresh) auto(id);
  }, [fresh, id, auto]);

  if (trouble?.id === id) {
    const blocked = trouble.kind === "blocked";
    return (
      <button
        type="button"
        className="voice-note"
        onClick={() => retry(id, trouble.kind)}
        title={
          !blocked
            ? "这段没生成出来，点一下再试一次"
            : trouble.pre
              ? "浏览器不让页面自己出声，点一下才开始念"
              : "被浏览器拦下来了，点一下就从这儿接着播"
        }
      >
        {!blocked ? "这段没生成出来" : trouble.pre ? "点一下播放" : "点一下才能出声"}
      </button>
    );
  }

  const on = status.id === id && status.phase !== "idle";
  return (
    <button
      type="button"
      data-on={on ? "1" : "0"}
      className="voice-btn"
      onClick={() => toggle(id)}
      aria-label="念出来"
      title={on ? "停一下" : "念出来"}
    >
      {status.id === id && status.phase === "loading" ? (
        <Loader2 size={12} strokeWidth={2} className="animate-spin" />
      ) : status.id === id && status.phase === "playing" ? (
        <Pause size={12} strokeWidth={2} />
      ) : status.id === id && status.phase === "paused" ? (
        <Play size={12} strokeWidth={2} />
      ) : (
        <Volume2 size={13} strokeWidth={1.8} />
      )}
    </button>
  );
}

const clock = (s: number) => {
  const n = Number.isFinite(s) && s > 0 ? Math.round(s) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

/**
 * 对话里的语音消息：一个能点的播放条。
 * 播放地址直接给 audio，点击里立刻 play()——不需要先下载，也不会被当成自动播放拦下来。
 */
export function VoiceClip({ src, auto }: { src: string; auto?: boolean }) {
  const quietRef = useContext(VoiceCtx)?.quietRef;
  const ref = useRef<HTMLAudioElement | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [secs, setSecs] = useState(0);
  const [pos, setPos] = useState(0);

  // 元素先建好只拿时长（preload=metadata，不出声），真正播放留给点击
  useEffect(() => {
    const a = new Audio(src);
    a.preload = "metadata";
    ref.current = a;
    const onMeta = () => setSecs(Number.isFinite(a.duration) ? a.duration : 0);
    a.onloadedmetadata = onMeta;
    a.ontimeupdate = () => setPos(a.currentTime);
    a.onended = () => {
      setPhase("idle");
      setPos(0);
    };
    a.onerror = () => setPhase("error");
    a.load();
    // 电话接起来了：语音消息也停
    const hush = () => {
      a.pause();
      setPhase("idle");
    };
    document.addEventListener("dongni:quiet", hush);
    return () => {
      document.removeEventListener("dongni:quiet", hush);
      a.pause();
      a.onloadedmetadata = null;
      a.ontimeupdate = null;
      a.onended = null;
      a.onerror = null;
      ref.current = null;
    };
  }, [src]);

  // 刚收到的语音回复：她刚说完话，直接出声；被浏览器拦了也不报错，点一下就播
  useEffect(() => {
    if (!auto || quietRef?.current) return;
    const a = ref.current;
    if (!a) return;
    setPhase("loading");
    a.play()
      .then(() => setPhase("playing"))
      .catch(() => setPhase("idle"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, src]);

  const on = () => {
    const a = ref.current;
    if (!a) return;
    if (phase === "playing") {
      a.pause();
      setPhase("idle");
      return;
    }
    setPhase("loading");
    a.play()
      .then(() => setPhase("playing"))
      .catch(() => setPhase("error"));
  };

  const pct = secs > 0 ? Math.min(100, (pos / secs) * 100) : 0;

  return (
    <button
      type="button"
      className="voice-clip"
      data-on={phase === "playing" ? "1" : "0"}
      onClick={on}
      aria-label={phase === "playing" ? "暂停" : "播放语音"}
      title={phase === "playing" ? "暂停" : "播放"}
    >
      <span className="voice-clip-icon">
        {phase === "loading" ? (
          <Loader2 size={13} strokeWidth={2.2} className="animate-spin" />
        ) : phase === "playing" ? (
          <Pause size={13} strokeWidth={2.2} />
        ) : (
          <Play size={13} strokeWidth={2.2} />
        )}
      </span>
      <span className="voice-clip-track">
        <span className="voice-clip-fill" style={{ width: `${pct}%` }} />
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`voice-clip-bar b${i}`} />
        ))}
      </span>
      <span className="voice-clip-time">{phase === "error" ? "听不了" : clock(secs)}</span>
    </button>
  );
}

