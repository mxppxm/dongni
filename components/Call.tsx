"use client";

import { motion } from "motion/react";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Mood from "./Mood";

/**
 * 打电话：麦克风 16k PCM 推给本机 3940（再转豆包实时语音），她的声音 24k PCM 回来边收边放。
 * 他一开口，服务端会发 clear，正在放的立刻停——能打断她。
 */
const WORKLET = `
class Mic16k extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.ratio = sampleRate / 16000; this.acc = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) { this.acc -= this.ratio; this.buf.push(ch[i]); }
    }
    while (this.buf.length >= 320) {
      const part = this.buf.splice(0, 320);
      const pcm = new Int16Array(320);
      let peak = 0;
      for (let i = 0; i < 320; i++) { const s = Math.max(-1, Math.min(1, part[i])); pcm[i] = s * 0x7fff; peak = Math.max(peak, Math.abs(s)); }
      this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("mic16k", Mic16k);
`;

type Phase = "connecting" | "live" | "ended" | "error";

export default function Call({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [muted, setMuted] = useState(false);
  const [talking, setTalking] = useState<"her" | "you" | null>(null);
  const [line, setLine] = useState("");
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState("");
  const mutedRef = useRef(false);
  const cleanup = useRef<() => void>(() => {});

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let next = 0;
    const playing = new Set<AudioBufferSourceNode>();
    let herTimer: number | undefined;

    const stopHer = () => {
      playing.forEach((s) => {
        try {
          s.stop();
        } catch {}
      });
      playing.clear();
      if (ctx) next = ctx.currentTime;
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        ctx = new AudioContext();
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        if (!alive) return;
        const src = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, "mic16k");
        src.connect(node);

        ws = new WebSocket(`ws://${location.hostname === "localhost" ? "127.0.0.1" : location.hostname}:${Number(location.port || 80) + 1}`);
        ws.binaryType = "arraybuffer";
        node.port.onmessage = (e) => {
          if (ws?.readyState !== WebSocket.OPEN) return;
          // 静音时照样送「空声音」，保持连线不断
          const pcm = mutedRef.current ? new Int16Array(320).buffer : e.data.pcm;
          ws.send(pcm);
          if (!mutedRef.current && e.data.peak > 0.08) setTalking((t) => (t === "her" ? t : "you"));
        };
        ws.onmessage = (e) => {
          if (!ctx) return;
          if (typeof e.data === "string") {
            const m = JSON.parse(e.data);
            if (m.type === "ready") setPhase("live");
            else if (m.type === "clear") stopHer();
            else if (m.type === "you") setLine(m.text);
            else if (m.type === "her") setLine(m.text);
            else if (m.type === "error") {
              setErr(m.message);
              setPhase("error");
            }
            return;
          }
          // 她的声音：24k 16 位单声道，一段段排着放
          const pcm = new Int16Array(e.data as ArrayBuffer);
          if (!pcm.length) return;
          const buf = ctx.createBuffer(1, pcm.length, 24000);
          const ch = buf.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
          const s = ctx.createBufferSource();
          s.buffer = buf;
          s.connect(ctx.destination);
          const at = Math.max(ctx.currentTime + 0.02, next);
          s.start(at);
          next = at + buf.duration;
          playing.add(s);
          s.onended = () => playing.delete(s);
          setTalking("her");
          window.clearTimeout(herTimer);
          herTimer = window.setTimeout(() => setTalking(null), Math.max(200, (next - ctx.currentTime) * 1000 + 200));
        };
        ws.onclose = () => alive && setPhase((p) => (p === "error" ? p : "ended"));
        ws.onerror = () => {
          setErr("电话线没接通");
          setPhase("error");
        };
      } catch (e) {
        setErr(e instanceof Error && e.name === "NotAllowedError" ? "没给麦克风权限" : "麦克风打不开");
        setPhase("error");
      }
    })();

    cleanup.current = () => {
      alive = false;
      stopHer();
      try {
        ws?.close();
      } catch {}
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
    return () => cleanup.current();
  }, []);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // 她说完一会儿，「你」的提示也收回去
  useEffect(() => {
    if (talking !== "you") return;
    const t = setTimeout(() => setTalking(null), 900);
    return () => clearTimeout(t);
  }, [talking, line]);

  const hangUp = () => {
    cleanup.current();
    onClose();
  };

  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const mood = phase === "connecting" ? "wave" : talking === "her" ? "cheer" : talking === "you" ? "think" : "think";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-[var(--bg)]"
    >
      <div className="pointer-events-none fixed inset-0 bg-[image:var(--glow-bg)]" />
      <div className="relative flex flex-col items-center">
        <motion.div
          animate={{ scale: talking === "her" ? [3.2, 3.45, 3.2] : 3.2 }}
          transition={talking === "her" ? { duration: 0.9, repeat: Infinity } : { duration: 0.3 }}
          className="mb-24 h-11 w-11"
        >
          <Mood mood={mood} />
        </motion.div>
        <div className="text-lg text-[var(--text-strong)]">敏</div>
        <div className="mt-1 h-5 text-sm text-[var(--dim)]">
          {phase === "connecting" ? "正在接通…" : phase === "live" ? mm : phase === "ended" ? "通话结束" : err}
        </div>
        <div className="mt-8 h-14 max-w-[520px] px-6 text-center text-[15px] leading-relaxed text-[var(--faint)]">
          {phase === "live" ? line.slice(-60) : ""}
        </div>
      </div>
      <div className="relative mt-10 flex items-center gap-10">
        <button
          onClick={() => setMuted((m) => !m)}
          className={`flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] transition-colors ${
            muted ? "bg-[var(--text-strong)] text-[var(--bg)]" : "bg-[var(--panel)] text-[var(--text)]"
          }`}
          aria-label={muted ? "打开麦克风" : "静音"}
        >
          {muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button
          onClick={hangUp}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-[#f05252] text-white shadow-[0_8px_24px_rgba(240,82,82,.35)]"
          aria-label="挂断"
        >
          <PhoneOff size={26} />
        </button>
      </div>
    </motion.div>
  );
}
