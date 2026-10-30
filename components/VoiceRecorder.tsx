"use client";

import { Loader2, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 按住说话那类，但这里改成点一下开始、再点一下发出去（免得手一滑就没了）。
 * 录的是 16k 单声道 wav——豆包识别要的就是这个，浏览器里直接算好，服务端不用再转格式。
 */
const MAX_SECONDS = 60;
const TARGET_RATE = 16000;

export type VoiceMsg = {
  id: number;
  clientId: string | null;
  role: "user" | "assistant";
  content: string;
  status: string;
  createdAt: number;
  kind?: string;
};

export type VoiceSendResult = {
  ok: boolean;
  reason?: string;
  clipId?: number;
  text?: string;
  user?: VoiceMsg;
  reply?: VoiceMsg;
};

type Rec = {
  ctx: AudioContext;
  stream: MediaStream;
  proc: ScriptProcessorNode;
  mute: GainNode;
  chunks: Float32Array[];
  rate: number;
  timer: number;
};

function resample(input: Float32Array, from: number, to: number) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/** 16 位单声道 wav */
function encodeWav(samples: Float32Array, rate: number) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function MicButton({
  onSent,
  onHint,
  onIntercept,
}: {
  onSent: (r: VoiceSendResult) => void;
  onHint: (t: string | null) => void;
  /** 正在打电话：麦克风已经在电话那边了，点这里就回到电话，不再另录一段 */
  onIntercept?: () => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "sending">("idle");
  const [secs, setSecs] = useState(0);
  const rec = useRef<Rec | null>(null);
  const stopRef = useRef<() => void>(() => {});

  useEffect(
    () => () => {
      const r = rec.current;
      if (!r) return;
      rec.current = null;
      window.clearInterval(r.timer);
      r.stream.getTracks().forEach((t) => t.stop());
      void r.ctx.close().catch(() => {});
    },
    [],
  );

  const stop = useCallback(async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    window.clearInterval(r.timer);
    onHint(null);
    try {
      r.proc.disconnect();
      r.mute.disconnect();
    } catch {
      // 已经断开就算了
    }
    r.stream.getTracks().forEach((t) => t.stop());
    const rate = r.rate;
    void r.ctx.close().catch(() => {});

    const total = r.chunks.reduce((n, c) => n + c.length, 0);
    if (total < rate * 0.25) {
      setState("idle");
      setSecs(0);
      onHint("太短啦，按住多说两句");
      return;
    }
    const all = new Float32Array(total);
    let off = 0;
    for (const c of r.chunks) {
      all.set(c, off);
      off += c.length;
    }
    const seconds = total / rate;
    const blob = encodeWav(resample(all, rate, TARGET_RATE), TARGET_RATE);
    setState("sending");
    try {
      const dataUrl = await new Promise<string>((ok, no) => {
        const fr = new FileReader();
        fr.onload = () => ok(String(fr.result));
        fr.onerror = () => no(fr.error);
        fr.readAsDataURL(blob);
      });
      const res = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: dataUrl, seconds, clientId: crypto.randomUUID(), mime: "audio/wav" }),
      });
      const json = (await res.json()) as VoiceSendResult;
      onSent(json);
    } catch {
      onHint("这段没发出去，再说一遍？");
    } finally {
      setState("idle");
      setSecs(0);
    }
  }, [onHint, onSent]);

  useEffect(() => {
    stopRef.current = () => void stop();
  }, [stop]);

  const start = useCallback(async () => {
    onHint(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      onHint("这个浏览器打不开麦克风，换个浏览器试试");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0; // 不把自己的声音放出来，免得啸叫
      const chunks: Float32Array[] = [];
      proc.onaudioprocess = (e) => {
        // 拷贝一份：inputBuffer 每次都会被复用
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      const t0 = Date.now();
      const timer = window.setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        setSecs(s);
        if (s >= MAX_SECONDS) stopRef.current();
      }, 250);
      rec.current = { ctx, stream, proc, mute, chunks, rate: ctx.sampleRate, timer };
      setSecs(0);
      setState("recording");
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      setState("idle");
      onHint(name === "NotAllowedError" ? "麦克风没开：在浏览器里允许用麦克风，再点一次" : "麦克风打不开，回头再试");
    }
  }, [onHint]);

  const onClick = () => {
    if (onIntercept && state === "idle") return onIntercept();
    if (state === "recording") void stop();
    else if (state === "idle") void start();
  };

  return (
    <span className="relative mb-0.5 flex shrink-0 items-center">
      {state === "recording" && <span className="mic-timer">● {clock(secs)} · 点一下发出去</span>}
      <button
        type="button"
        onClick={onClick}
        data-rec={state === "recording" ? "1" : "0"}
        disabled={state === "sending"}
        className="mic-btn flex h-9 w-9 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
        aria-label={state === "recording" ? "发出去" : "说一句"}
        title={state === "recording" ? "点一下发出去" : state === "sending" ? "在听…" : "说一句"}
      >
        {state === "sending" ? (
          <Loader2 size={17} strokeWidth={2} className="animate-spin" />
        ) : state === "recording" ? (
          <Square size={13} strokeWidth={2.6} fill="currentColor" />
        ) : (
          <Mic size={17} strokeWidth={1.8} />
        )}
      </button>
    </span>
  );
}