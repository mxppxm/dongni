"use client";

import { Loader2, Pause, Play, Volume2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * 念出来：一条回复一个小按钮，默认不自动念（设置里可以开）。
 * 切到别的消息会先停上一条；念不出来就静默降级，只留一句「这条念不出来」。
 */
const AUTO_KEY = "dongni:voiceAuto";

type Phase = "idle" | "loading" | "playing" | "paused";
type Status = { id: number | null; phase: Phase };

type VoiceCtxValue = {
  autoplay: boolean;
  setAutoplay: (v: boolean) => void;
  status: Status;
  errorId: number | null;
  toggle: (id: number) => void;
  auto: (id: number) => void;
};

const VoiceCtx = createContext<VoiceCtxValue | null>(null);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const [autoplay, setAutoplayState] = useState(false);
  const [status, setStatus] = useState<Status>({ id: null, phase: "idle" });
  const [errorId, setErrorId] = useState<number | null>(null);
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
      a.pause();
    }
    if (url.current) {
      URL.revokeObjectURL(url.current);
      url.current = null;
    }
    setStatus({ id: null, phase: "idle" });
  }, []);

  useEffect(() => () => stop(), [stop]);

  const fail = useCallback((id: number) => {
    setStatus({ id: null, phase: "idle" });
    setErrorId(id);
    window.setTimeout(() => setErrorId((cur) => (cur === id ? null : cur)), 3000);
  }, []);

  const play = useCallback(
    async (id: number) => {
      stop();
      setStatus({ id, phase: "loading" });
      try {
        const res = await fetch(`/api/voice/${id}`);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const src = URL.createObjectURL(blob);
        url.current = src;
        const a = new Audio(src);
        audio.current = a;
        a.onended = () => setStatus({ id, phase: "idle" });
        a.onerror = () => fail(id);
        await a.play();
        setStatus({ id, phase: "playing" });
      } catch {
        fail(id);
      }
    },
    [stop, fail],
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
            .catch(() => fail(id));
          return;
        }
        if (status.phase === "loading") return;
      }
      void play(id);
    },
    [status, play, fail],
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
      if (!v) stop();
    },
    [stop],
  );

  const value = useMemo<VoiceCtxValue>(
    () => ({ autoplay, setAutoplay, status, errorId, toggle, auto }),
    [autoplay, setAutoplay, status, errorId, toggle, auto],
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
export function VoiceButton({ id }: { id: number }) {
  const { status, errorId, toggle } = useVoice();
  const on = status.id === id && status.phase !== "idle";
  if (errorId === id) return <span className="voice-note">这条念不出来</span>;
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