"use client";

import { Loader2, Pause, Play, Volume2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * 念出来：一条回复一个小按钮，默认不自动念（设置里可以开）。
 * 切到别的消息会先停上一条。
 * 浏览器默认不许页面凭空出声，两种不出声要分得开、都得给出路：
 * 一是被拦——播之前先看浏览器给没给过用户手势，判定会被拦就直接摆「点一下播放」，
 * 真播了被 NotAllowedError 挡回来就说「点一下才能出声」；这两种点一下就接着播，音频不用重新合成。
 * 二是没生成出来——接口没合成、解码失败（别的 error.name），说「这段没生成出来」，点了从头重试。
 */
const AUTO_KEY = "dongni:voiceAuto";
/** 44 字节的空 wav：只为在同一次点击里把 audio 元素解锁，Safari 只认用户手势里的第一次 play */
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

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
  const url = useRef<string | null>(null);
  const autoOn = useRef(false);

  useEffect(() => {
    const on = localStorage.getItem(AUTO_KEY) === "1";
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
    if (url.current) {
      URL.revokeObjectURL(url.current);
      url.current = null;
    }
    setStatus({ id: null, phase: "idle" });
  }, []);

  useEffect(() => () => stop(), [stop]);

  const play = useCallback(
    async (id: number, gesture = false) => {
      stop();
      setTrouble(null);
      setStatus({ id, phase: "loading" });
      let a: HTMLAudioElement | null = null;
      try {
        a = new Audio();
        audio.current = a;
        // 先在这同一次点击里解锁，否则等下载完再播，Safari 会当成自动播放拦掉
        if (gesture) {
          a.src = SILENT;
          a.muted = true;
          try {
            await a.play();
            a.pause();
          } catch {
            // 解锁失败也照样往下走，真被拦了下面会摆出「点一下才能出声」
          }
          a.muted = false;
        }
        const res = await fetch(`/api/voice/${id}`);
        if (!res.ok) throw new Error(`voice ${res.status}`);
        const blob = await res.blob();
        const src = URL.createObjectURL(blob);
        url.current = src;
        a.src = src;
        a.onended = () => setStatus({ id, phase: "idle" });
        // 音频元素自己报错（解码不了、格式不对）就是没生成出能放的东西
        a.onerror = () => {
          setStatus({ id: null, phase: "idle" });
          setTrouble({ id, kind: "synth" });
        };
        // 播之前先判断一次 autoplay 策略：这次不是用户点出来的、页面又没拿到过手势，
        // 那 play() 必然被拦——别硬播留一条静默报错，直接把「点一下播放」摆到这条消息下面，音频已经备好了
        if (!gesture && !hasGesture()) {
          setStatus({ id: null, phase: "idle" });
          setTrouble({ id, kind: "blocked", pre: true });
          return;
        }
        try {
          await a.play();
        } catch (e) {
          setStatus({ id: null, phase: "idle" });
          setTrouble({ id, kind: isBlocked(e) ? "blocked" : "synth" });
          return;
        }
        setStatus({ id, phase: "playing" });
      } catch {
        if (a) {
          a.onerror = null;
          a.pause();
        }
        audio.current = null;
        setStatus({ id: null, phase: "idle" });
        setTrouble({ id, kind: "synth" });
      }
    },
    [stop],
  );

  /** 被浏览器拦下来的那条，音频其实已经下好了：点一下就接着播，不重新合成 */
  const retry = useCallback(
    (id: number, kind: "synth" | "blocked") => {
      const a = audio.current;
      const src = a?.getAttribute("src");
      if (kind === "blocked" && a && src && src !== SILENT) {
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
      void play(id, true);
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
      void play(id, true);
    },
    [status, play],
  );

  const auto = useCallback(
    (id: number) => {
      if (autoOn.current) void play(id);
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

  const value = useMemo<VoiceCtxValue>(
    () => ({ autoplay, setAutoplay, status, trouble, toggle, retry, auto }),
    [autoplay, setAutoplay, status, trouble, toggle, retry, auto],
  );

  return <VoiceCtx.Provider value={value}>{children}</VoiceCtx.Provider>;
}

export function useVoice() {
  const v = useContext(VoiceCtx);
  if (!v) throw new Error("VoiceProvider 没套上");
  return v;
}

/** 有没有能念的字（纯图、纯代码的消息不显示按钮） */
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