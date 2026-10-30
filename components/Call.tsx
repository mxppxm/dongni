"use client";

import { motion } from "motion/react";
import { AudioLines, Maximize2, Mic, MicOff, Minimize2, PhoneOff } from "lucide-react";
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

export default function Call({ onClose, mini, onMini }: { onClose: () => void; mini: boolean; onMini: (v: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [muted, setMuted] = useState(false);
  const [talking, setTalking] = useState<"her" | "you" | null>(null);
  const [line, setLine] = useState("");
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState("");
  // 声纹：off 没录过；on 只听他的；数字 = 正在录（进度 0～1）
  const [vp, setVp] = useState<"off" | "on" | number>("off");
  const [vpHint, setVpHint] = useState("");
  const mutedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
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
        wsRef.current = ws;
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
            if (m.type === "ready") {
              setPhase("live");
              setVp(m.voiceprint ? "on" : "off");
            } else if (m.type === "enroll") setVp(m.progress);
            else if (m.type === "enrolled") {
              setVp("on");
              setVpHint("记住你的声音了");
            } else if (m.type === "enroll-failed") {
              setVp((v) => (typeof v === "number" ? "off" : v));
              setVpHint(m.message);
            }
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

  useEffect(() => {
    if (!vpHint) return;
    const t = setTimeout(() => setVpHint(""), 3000);
    return () => clearTimeout(t);
  }, [vpHint]);

  const enroll = () => {
    if (wsRef.current?.readyState !== WebSocket.OPEN || typeof vp === "number") return;
    setMuted(false);
    setVp(0);
    wsRef.current.send(JSON.stringify({ type: "enroll" }));
  };

  const hangUp = () => {
    cleanup.current();
    onClose();
  };

  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const mood = phase === "connecting" ? "wave" : talking === "her" ? "cheer" : talking === "you" ? "think" : "think";

  const enrollingNow = typeof vp === "number";
  const status = phase === "connecting" ? "正在接通…" : phase === "live" ? mm : phase === "ended" ? "通话结束" : err;
  const vpButton = (
    <button
      onClick={enroll}
      disabled={phase !== "live"}
      className={`relative flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] transition-colors disabled:opacity-40 ${
        vp === "on" ? "text-[var(--dot)]" : "text-[var(--text)]"
      }`}
      aria-label="声纹"
      title={vp === "on" ? "只听你的声音（点一下重录）" : "录声纹：只听你的声音"}
    >
      <AudioLines size={22} />
      {enrollingNow && (
        <svg className="absolute inset-[-3px] -rotate-90" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="18.5" fill="none" stroke="var(--dot)" strokeWidth="2" strokeDasharray={`${116 * (vp as number)} 116`} />
        </svg>
      )}
    </button>
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
      {mini ? (
        <motion.div
          drag
          dragMomentum={false}
          initial={{ opacity: 0, scale: 0.85, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          className="fixed right-5 bottom-28 z-40 flex cursor-grab items-center gap-2.5 rounded-full border border-[var(--border)] bg-[var(--panel)] py-2 pr-2 pl-2.5 shadow-[var(--shadow)] backdrop-blur-xl active:cursor-grabbing"
        >
          <motion.div
            animate={{ scale: talking === "her" ? [1, 1.12, 1] : 1 }}
            transition={talking === "her" ? { duration: 0.9, repeat: Infinity } : { duration: 0.3 }}
            className="h-9 w-9 shrink-0 overflow-hidden"
          >
            <Mood mood={mood} />
          </motion.div>
          <div className="min-w-[52px] leading-tight">
            <div className="text-[13px] text-[var(--text-strong)]">敏</div>
            <div className="text-[11px] text-[var(--dim)] tabular-nums">{enrollingNow ? "录声纹…" : status}</div>
          </div>
          <button
            onClick={() => setMuted((m) => !m)}
            className={`flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] transition-colors ${
              muted ? "bg-[var(--text-strong)] text-[var(--bg)]" : "bg-[var(--panel)] text-[var(--text)]"
            }`}
            aria-label={muted ? "打开麦克风" : "静音"}
          >
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            onClick={() => onMini(false)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[var(--text)]"
            aria-label="展开"
          >
            <Maximize2 size={15} />
          </button>
          <button onClick={hangUp} className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f05252] text-white" aria-label="挂断">
            <PhoneOff size={16} />
          </button>
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-[var(--bg)]"
        >
          <div className="pointer-events-none fixed inset-0 bg-[image:var(--glow-bg)]" />
          <button
            onClick={() => onMini(true)}
            className="absolute top-4 left-4 flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
            aria-label="最小化"
            title="最小化"
          >
            <Minimize2 size={18} strokeWidth={1.6} />
          </button>
          <div className="relative flex flex-col items-center">
            <motion.div
              animate={{ scale: talking === "her" ? [3.2, 3.45, 3.2] : 3.2 }}
              transition={talking === "her" ? { duration: 0.9, repeat: Infinity } : { duration: 0.3 }}
              className="mb-24 h-11 w-11"
            >
              <Mood mood={mood} />
            </motion.div>
            <div className="text-lg text-[var(--text-strong)]">敏</div>
            <div className="mt-1 h-5 text-sm text-[var(--dim)]">{status}</div>
            <div className="mt-8 h-14 max-w-[520px] px-6 text-center text-[15px] leading-relaxed text-[var(--faint)]">
              {enrollingNow ? "随便说几句话，让她记住你的声音" : vpHint || (phase === "live" ? line.slice(-60) : "")}
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
            {vpButton}
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
