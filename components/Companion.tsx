"use client";

import { createElement, useEffect, useRef, useState, type CSSProperties } from "react";
import { motion as Motion, useMotionValue } from "motion/react";
import { getCompanionMotion, type CompanionAction, type CompanionPresentation, type CompanionState } from "@/lib/companion-state";
import { useMoodInfo } from "./Mood";
import styles from "./Companion.module.css";

export type { CompanionState } from "@/lib/companion-state";

const LABELS: Record<CompanionState, string> = {
  idle: "我在呢", typing: "听你说", thinking: "让我想想", working: "正在忙", success: "好啦",
  confused: "等你看一下", failure: "这次没弄成", listening: "在听你说", speaking: "正在回应",
};

type Avatar = HTMLElement & {
  play(action: CompanionAction): unknown;
  reset(): unknown;
  startWaiting(options: { variant: "spin" | "wrap" | "wave" }): Promise<unknown>;
  noteActivity(wake?: boolean): void;
};
let runtime: Promise<void> | null = null;
function loadRuntime() {
  if (customElements.get("boop-face")) return Promise.resolve();
  runtime ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = "/companion/boopface/boopface.js";
    script.onload = () => customElements.get("boop-face") ? resolve() : reject(new Error("BoopFace did not register"));
    script.onerror = () => reject(new Error("BoopFace could not load"));
    document.head.append(script);
  }).catch(error => { runtime = null; throw error; });
  return runtime;
}

/** Only the visual companion changes. Original Min artwork and persona stay in their existing features. */
export default function Companion({ state = "idle", label, mood, activityKey, size = 112, caption = false, movable = false }: {
  state?: CompanionState; label?: string; mood?: string; activityKey?: string; size?: number; caption?: boolean; movable?: boolean;
}) {
  const face = useRef<Avatar | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const [greeting, setGreeting] = useState(0);
  const previousGreeting = useRef(0);
  const moodInfo = useMoodInfo(mood);
  const motion = getCompanionMotion(state, moodInfo);
  const action = motion.action;
  const waiting = motion.waiting;

  useEffect(() => {
    let live = true;
    void loadRuntime().then(() => { if (live) setReady(true); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const avatar = face.current;
    if (!ready || !avatar) return;
    const onState = (event: Event) => {
      const value = (event as CustomEvent<{ state: string }>).detail.state;
      setAsleep(value === "sleep");
    };
    avatar.addEventListener("face-state", onState);
    return () => avatar.removeEventListener("face-state", onState);
  }, [ready]);

  useEffect(() => {
    const avatar = face.current;
    if (!ready || !avatar) return;
    let live = true;
    // Cancels the previous expression, gesture and pending waiting transition.
    avatar.reset();
    avatar.noteActivity();
    setAsleep(false);
    const greet = previousGreeting.current !== greeting;
    previousGreeting.current = greeting;
    const run = async () => {
      if (greet) await avatar.play("affirm");
      else if (action !== "idle") await avatar.play(action);
      if (live && waiting) await avatar.startWaiting({ variant: waiting });
    };
    void run().catch(() => { if (live) setFailed(true); });
    return () => { live = false; avatar.reset(); };
  }, [ready, action, waiting, activityKey, greeting]);

  const text = failed ? "角色加载失败" : asleep ? "眯一会儿" : label || LABELS[state];
  return (
    <div className={styles.companion} style={{ "--companion-size": `${size}px` } as CSSProperties}
      data-state={state} data-skin="504" data-ready={ready && !failed} data-mood={mood}>
      <div className={styles.stage} role="button" tabIndex={0}
        aria-label={`陪伴角色，${text}。${movable ? "可拖动到窗口任意位置，方向键调整位置" : "可拖动、按住挤压或双击互动"}，按回车打招呼`}
        title={movable ? "拖动改变位置，双击打招呼" : "可以拖动、按住挤压、拉天线，或双击互动"}
        onKeyDown={event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault(); event.stopPropagation();
          setGreeting(value => value + 1);
        }}
        onDoubleClick={() => setGreeting(value => value + 1)}>
        {createElement("boop-face", {
          ref: face, size: String(size), skin: "504", motion: "auto", "auto-sleep": state === "idle" ? "90000" : "0", "wake-on": "activity",
        })}
        {(!ready || failed) && <span className={styles.fallback} aria-hidden="true"><i /><i /></span>}
      </div>
      {caption && <span className={styles.caption} role="status">{text}</span>}
    </div>
  );
}

/** Desktop companion remains next to chat; narrow screens use space above the composer. */
export function CompanionDock(props: CompanionPresentation) {
  const bounds = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const x = useMotionValue(0), y = useMotionValue(0);
  // Keep the character reachable after a window resize or a mobile orientation change.
  useEffect(() => {
    const constrain = () => {
      const rect = dock.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = rect.left < 12 ? 12 - rect.left : rect.right > innerWidth - 12 ? innerWidth - 12 - rect.right : 0;
      const dy = rect.top < 12 ? 12 - rect.top : rect.bottom > innerHeight - 12 ? innerHeight - 12 - rect.bottom : 0;
      x.set(x.get() + dx); y.set(y.get() + dy);
    };
    window.addEventListener("resize", constrain);
    return () => window.removeEventListener("resize", constrain);
  }, [x, y]);
  return <div className={styles.slot}>
    <div ref={bounds} className={styles.dragBounds} aria-hidden="true" />
    <Motion.aside ref={dock} className={styles.dock} aria-label="陪伴角色的状态" data-draggable="viewport"
      style={{ x, y }} drag dragConstraints={bounds} dragMomentum={false} dragElastic={0}
      onKeyDown={event => {
        const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
        const rect = dock.current?.getBoundingClientRect();
        if (!delta || !rect) return;
        event.preventDefault(); event.stopPropagation();
        x.set(x.get() + Math.max(12 - rect.left, Math.min(innerWidth - 12 - rect.right, delta[0])));
        y.set(y.get() + Math.max(12 - rect.top, Math.min(innerHeight - 12 - rect.bottom, delta[1])));
      }}>
      <Companion {...props} movable />
    </Motion.aside>
  </div>;
}
