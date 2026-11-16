"use client";

import { animate, motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import styles from "./Companion.module.css";

export type CompanionState = "idle" | "typing" | "thinking" | "working" | "success" | "confused" | "listening" | "speaking";

const LABELS: Record<CompanionState, string> = {
  idle: "我在呢", typing: "听你说", thinking: "让我想想", working: "正在忙", success: "好啦", confused: "等你看一下", listening: "在听你说", speaking: "正在回应",
};
const ATLAS = "/companion/min-atlas.png";

/** 头部与身体独立运动；图集上排是四种脸，下排是四种身体姿态。 */
export default function Companion({ state = "idle", label, size = 112, caption = false }: {
  state?: CompanionState; label?: string; size?: number; caption?: boolean;
}) {
  const reduce = useReducedMotion();
  const [loaded, setLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const [gesture, setGesture] = useState<"wave" | "press" | null>(null);
  const [celebrated, setCelebrated] = useState(false);
  const clearGesture = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const down = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const x = useMotionValue(0), y = useMotionValue(0);
  const lookX = useSpring(0, { stiffness: 170, damping: 22 });
  const lookY = useSpring(0, { stiffness: 170, damping: 22 });
  const turn = useSpring(0, { stiffness: 170, damping: 22 });

  useEffect(() => {
    let live = true;
    let remaining = 2;
    const images = [ATLAS, "/companion/min-bodies.png"].map((src) => {
      const image = new Image();
      image.onload = () => { if (live && --remaining === 0) setLoaded(true); };
      image.src = src;
      return image;
    });
    return () => { live = false; images.forEach((image) => { image.onload = null; }); };
  }, []);

  useEffect(() => {
    const visibility = () => setPaused(document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  useEffect(() => {
    setCelebrated(false);
    if (state !== "success") return;
    const t = setTimeout(() => setCelebrated(true), 2400);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    setAsleep(false);
    if (state !== "idle") return;
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setAsleep(false);
      clearTimeout(timer);
      timer = setTimeout(() => setAsleep(true), 90_000);
    };
    wake();
    window.addEventListener("pointerdown", wake, { passive: true });
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [state]);

  useEffect(() => () => clearTimeout(clearGesture.current), []);

  const wave = () => {
    clearTimeout(clearGesture.current);
    setAsleep(false);
    setGesture("wave");
    clearGesture.current = setTimeout(() => setGesture(null), 1800);
  };
  const rest = () => { lookX.set(0); lookY.set(0); turn.set(0); };
  const release = () => {
    down.current = null;
    setGesture((g) => g === "press" ? null : g);
  };
  const shown = state === "success" && celebrated ? "idle" : state;
  const waving = gesture === "wave" || shown === "success";
  const face = asleep ? 1 : shown === "confused" ? 3 : shown === "speaking" || waving ? 2 : 0;
  const body = waving ? 2 : shown === "working" ? 1 : shown === "speaking" ? 3 : 0;
  const text = gesture === "wave" ? "嗨，我在呢" : asleep ? "眯一会儿" : state === "success" && celebrated ? LABELS.idle : label || LABELS[shown];
  const sprite = (column: number, row: number): CSSProperties => ({ backgroundPosition: `${column * 100 / 3}% ${row * 100}%` });

  return (
    <div className={styles.companion} style={{ "--companion-size": `${size}px` } as CSSProperties} data-state={shown} data-wave={waving} data-sleep={asleep} data-paused={paused || !!reduce}>
      <motion.button
        type="button"
        className={styles.stage}
        aria-label={`敏，${text}。点击和她打招呼，可以轻轻拖动她`}
        title="点一下打招呼，也可以轻轻拖动"
        style={{ x, y }}
        drag={!reduce}
        dragMomentum={false}
        dragConstraints={{ left: -24, right: 24, top: -16, bottom: 12 }}
        dragElastic={0.12}
        animate={{ scaleX: gesture === "press" && !reduce ? 1.045 : 1, scaleY: gesture === "press" && !reduce ? 0.955 : 1 }}
        transition={{ type: "spring", stiffness: 310, damping: 19 }}
        onDragStart={() => { dragged.current = true; setGesture(null); }}
        onDragEnd={() => {
          animate(x, 0, { type: "spring", stiffness: 250, damping: 18 });
          animate(y, 0, { type: "spring", stiffness: 250, damping: 18 });
          release(); rest();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragged.current = false;
          down.current = { x: e.clientX, y: e.clientY };
          setAsleep(false);
          setGesture("press");
        }}
        onPointerMove={(e) => {
          if (down.current && Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > 5) dragged.current = true;
          if (reduce || e.pointerType === "touch") return;
          const rect = e.currentTarget.getBoundingClientRect();
          const px = Math.max(-1, Math.min(1, (e.clientX - rect.left) / rect.width * 2 - 1));
          const py = Math.max(-1, Math.min(1, (e.clientY - rect.top) / rect.height * 2 - 1));
          lookX.set(px * 2.5); lookY.set(py * 1.5); turn.set(px * 3);
        }}
        onPointerUp={release}
        onPointerCancel={() => { dragged.current = true; release(); rest(); }}
        onPointerLeave={() => { release(); rest(); }}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={() => { if (!dragged.current) wave(); dragged.current = false; }}
      >
        {!loaded ? <img className={styles.fallback} src="/mood/anchor.png" alt="" draggable={false} /> : (
          <span className={styles.puppet} aria-hidden="true">
            <span className={styles.bodyMotion}><span className={styles.body} style={sprite(body, 0)} /></span>
            <motion.span className={styles.headFollow} style={{ x: lookX, y: lookY, rotate: turn }}>
              <span className={styles.headMotion}>
                <span className={styles.face} style={sprite(face, 0)} />
                {!asleep && <span className={`${styles.face} ${styles.blink}`} style={sprite(1, 0)} />}
                {shown === "speaking" && <span className={`${styles.face} ${styles.speech}`} style={sprite(0, 0)} />}
              </span>
            </motion.span>
          </span>
        )}
      </motion.button>
      {caption && <span className={styles.caption}>{text}</span>}
    </div>
  );
}

/** 桌面放在对话右侧，窄屏收进输入框上方，避免挡住消息和发送按钮。 */
export function CompanionDock(props: { state: CompanionState; label?: string }) {
  return <div className={styles.slot}><aside className={styles.dock} aria-label="敏的状态"><Companion {...props} caption /></aside></div>;
}
