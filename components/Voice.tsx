"use client";

import { Loader2, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * 语音消息条（他发的、她回的语音）。「念出来」那套（每条回复一个播放按钮、自动念）已经拿掉了：
 * 每条回复都要合成一遍语音，打字聊天也在花语音的钱。
 */

/** 打电话的时候页面自己不出声（电话里她已经在说了）：正在播的语音条停下，新来的也不自动播 */
let quiet = false;
export function setPageQuiet(v: boolean) {
  quiet = v;
  if (v) document.dispatchEvent(new Event("dongni:quiet"));
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
    if (!auto || quiet) return;
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

