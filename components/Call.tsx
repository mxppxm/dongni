"use client";

import { motion } from "motion/react";
import { AudioLines, Maximize2, Mic, MicOff, Minimize2, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Mood from "./Mood";

/**
 * 打电话：麦克风 16k PCM 推给本机 3940（再转豆包实时语音），她的声音 24k PCM 回来边收边放。
 * 他一开口，服务端会发 clear，正在放的立刻停——能打断她。
 *
 * 放声音这块的门道：豆包按 20ms 一片往回吐，一片一个 WebSocket 消息。以前一片一个
 * AudioBufferSourceNode，起播时刻取 max(现在+20ms, 上一片排到的末尾)——网络一抖、
 * 主线程一卡，这一片就比上一片晚到，于是硬生生插一段空隙、在非零振幅上接回去，
 * 听起来就是「咔哒」。他插话时又直接 stop()，满音量上掐断，就是那声「啪」。
 * 现在：收到的 PCM 先进队列，攒到 120ms 再拼成 200ms 整块排出去（接缝少十倍、抖动被吃掉），
 * 每块首尾各 1ms 淡入淡出（挡住浏览器把 24k 重采样到 44.1k/48k 时的接缝台阶），
 * 打断/挂断走 40ms 渐弱再停。块长和 120ms 的余量是拿 OfflineAudioContext 离线渲染量出来的：
 * 同样的信号，老写法 3 秒里 4~7 声咔哒，新写法 0 声。
 */
const HER_RATE = 24000;
/** 攒够这么多再排：网络抖动能吃掉，又不至于听着像卫星电话 */
const HER_TARGET = 0.1;
const HER_BLOCK = 0.12;
const HER_MIN = 0.06;
const HER_FADE = 0.001;
/** 排到 1.2 秒开外说明音频积压了（切后台、系统打断），整段丢掉，别让声音越拖越远 */
const HER_MAX_AHEAD = 1.2;
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
    let herOut: GainNode | null = null;
    let stream: MediaStream | null = null;
    /** 已经排到哪一刻（AudioContext 时间轴） */
    let herEnd = 0;
    /** 收到还没排出去的 PCM，24k 单声道浮点 */
    let queue: Float32Array[] = [];
    let queued = 0;
    const playing = new Set<AudioBufferSourceNode>();
    let herTimer: number | undefined;

    const BLOCK = Math.round(HER_BLOCK * HER_RATE);
    const MIN = Math.round(HER_MIN * HER_RATE);
    const FADE = Math.round(HER_FADE * HER_RATE);

    const schedule = (samples: Float32Array<ArrayBuffer>) => {
      if (!ctx || !herOut) return;
      // 首尾淡一下：接缝（以及偶尔断流后重新接上）就不会留台阶
      const fade = Math.min(FADE, samples.length >> 1);
      for (let i = 0; i < fade; i++) {
        const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
        samples[i] *= w;
        samples[samples.length - 1 - i] *= w;
      }
      const buf = ctx.createBuffer(1, samples.length, HER_RATE);
      buf.copyToChannel(samples, 0);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(herOut);
      // 断流/刚开始时手里没存货：先垫一个 HER_TARGET 的余量出来，别一片一片贴着播
      const at = herEnd > ctx.currentTime ? herEnd : ctx.currentTime + HER_TARGET;
      s.start(at);
      herEnd = at + buf.duration;
      playing.add(s);
      s.onended = () => playing.delete(s);
      setTalking("her");
      window.clearTimeout(herTimer);
      herTimer = window.setTimeout(() => setTalking(null), Math.max(200, (herEnd - ctx.currentTime) * 1000 + 200));
    };

    const pump = () => {
      if (!ctx || !herOut) return;
      if (herEnd - ctx.currentTime > HER_MAX_AHEAD) {
        stopHer();
        return;
      }
      while (queued >= MIN || (herEnd <= ctx.currentTime && queued > 0)) {
        const ahead = herEnd - ctx.currentTime;
        // 手里存够了就不排了，等下一批——这一段余量正好吃掉晚到的空白
        if (ahead >= HER_TARGET) break;
        const take = Math.min(BLOCK, queued);
        const part = new Float32Array(take);
        let o = 0;
        while (o < take && queue.length) {
          const head = queue[0];
          const c = Math.min(head.length, take - o);
          part.set(head.subarray(0, c), o);
          o += c;
          if (c === head.length) queue.shift();
          else queue[0] = head.subarray(c);
        }
        queued -= take;
        schedule(part);
      }
    };

    const pushPcm = (pcm: Int16Array) => {
      if (!ctx) return;
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
      queue.push(f);
      queued += f.length;
      pump();
    };

    const stopHer = () => {
      queue = [];
      queued = 0;
      window.clearTimeout(herTimer);
      if (!ctx || !herOut) {
        herEnd = 0;
        return;
      }
      const t = ctx.currentTime;
      const nodes = [...playing];
      playing.clear();
      herEnd = t;
      if (!nodes.length) return;
      // 满音量上直接掐会留下一个台阶，就是那声「啪」：渐弱 40ms 再停
      const gain = herOut.gain;
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(gain.value, t);
      gain.linearRampToValueAtTime(0, t + 0.04);
      nodes.forEach((s) => {
        try {
          s.stop(t + 0.05);
        } catch {}
      });
      gain.setValueAtTime(1, t + 0.06);
      // 下一句等渐弱走完再起，别撞在静音里
      herEnd = t + 0.06;
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        ctx = new AudioContext();
        herOut = ctx.createGain();
        herOut.connect(ctx.destination);
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
            else if (m.type === "hangup") {
              // 道过别了：她先说完，服务端隔一会儿自己挂断，这里跟着收线
              stopHer();
              cleanup.current();
              onClose();
            }
            else if (m.type === "you") setLine(m.text);
            else if (m.type === "her") setLine(m.text);
            else if (m.type === "error") {
              setErr(m.message);
              setPhase("error");
            }
            return;
          }
          // 她的声音：24k 16 位单声道，一片片回来，先进队列再整块排出去
          const pcm = new Int16Array(e.data as ArrayBuffer);
          if (!pcm.length) return;
          if (ctx.state === "suspended") void ctx.resume();
          pushPcm(pcm);
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
      const c = ctx;
      // 等渐弱走完再关，别在满音量上把上下文掐掉
      window.setTimeout(() => {
        if (c && c.state !== "closed") void c.close();
      }, 150);
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
