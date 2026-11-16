"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { BoopFace } from "../vendor/boopface/index";
import styles from "./Companion.module.css";

export type CompanionState = "idle" | "typing" | "thinking" | "working" | "success" | "confused" | "listening" | "speaking";
const LABELS: Record<CompanionState, string> = {
  idle: "我在呢", typing: "听你说", thinking: "让我想想", working: "正在忙", success: "好啦", confused: "等你看一下", listening: "在听你说", speaking: "正在回应",
};
let runtime: Promise<typeof import("./minCharacter.js")> | null = null;

function showState(element: BoopFace, state: CompanionState) {
  element.setAttribute("data-speaking", String(state === "speaking"));
  element.reset();
  const result = state === "typing" ? element.play("inspect")
    : state === "thinking" ? element.startWaiting({ variant: "wave" })
    : state === "working" ? element.startWaiting({ variant: "spin" })
    : state === "success" ? element.play("success")
    : state === "confused" ? element.play("wary")
    : state === "listening" ? element.play("inspect") : undefined;
  void Promise.resolve(result).catch(() => {});
}


/** 使用 BoopFace 的真实状态、眼睛和手势引擎；角色为同一张连续的 SVG。 */
export default function Companion({ state = "idle", label, size = 144, caption = false }: {
  state?: CompanionState; label?: string; size?: number; caption?: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const face = useRef<BoopFace | null>(null);
  const wanted = useRef(state);
  wanted.current = state;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [greeting, setGreeting] = useState(false);
  const greetingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let element: BoopFace | null = null;
    const greet = () => {
      if (!element) return;
      void Promise.resolve(element.play("affirm")).then(() => {
        if (alive && element && ["typing", "thinking", "working"].includes(wanted.current)) showState(element, wanted.current);
      }).catch(() => {});
      setGreeting(true);
      clearTimeout(greetingTimer.current);
      greetingTimer.current = setTimeout(() => setGreeting(false), 1800);
    };
    const restoreAfterGesture = (event: Event) => {
      const detail = (event as CustomEvent<{source:string;phase:string}>).detail;
      if (detail.source !== "interaction" || detail.phase !== "end") return;
      queueMicrotask(() => {
        if (alive && element && ["typing", "thinking", "working"].includes(wanted.current)) showState(element, wanted.current);
      });
    };
    const keyboard = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); greet(); }
    };
    (runtime ??= import("./minCharacter.js")).then(() => {
      if (!alive || !mount.current) return;
      element = document.createElement("boop-face") as BoopFace;
      element.setAttribute("data-character", "min");
      element.setAttribute("color", "#f7d4bd");
      element.setAttribute("auto-sleep", "90000");
      element.setAttribute("wake-on", "activity");
      element.setAttribute("motion", "auto");
      element.setAttribute("antenna-drag", "false");
      element.setAttribute("role", "button");
      element.setAttribute("tabindex", "0");
      element.setAttribute("title", "点一下打招呼，按住脸颊或轻轻拖动试试");
      element.style.cssText = "display:block;width:100%;height:100%;--face-size:100%;";
      element.addEventListener("click", greet);
      element.addEventListener("keydown", keyboard);
      element.addEventListener("action-state", restoreAfterGesture);
      face.current = element;
      mount.current.appendChild(element);
      setReady(true);
    }).catch(() => { if (alive) setFailed(true); });
    return () => {
      alive = false;
      clearTimeout(greetingTimer.current);
      element?.removeEventListener("click", greet);
      element?.removeEventListener("keydown", keyboard);
      element?.removeEventListener("action-state", restoreAfterGesture);
      element?.remove();
      face.current = null;
    };
  }, []);

  useEffect(() => {
    const element = face.current;
    if (!ready || !element) return;
    showState(element, state);
  }, [state, ready]);

  const text = greeting ? "嗨，我在呢" : label || LABELS[state];
  useEffect(() => { face.current?.setAttribute("aria-label", `敏，${text}。可以点击、按压或拖动`); }, [text, ready]);

  return (
    <div className={styles.companion} style={{ "--companion-size": `${size}px` } as CSSProperties}>
      <div className={styles.stage}>
        <div ref={mount} className={styles.mount} />
        {!ready && <img className={styles.fallback} src="/mood/anchor.png" alt={failed ? "敏的动态形象暂未加载" : "敏"} draggable={false} />}
      </div>
      {caption && <div className={styles.caption}>{state !== "idle" || greeting || label ? text : ""}</div>}
    </div>
  );
}

export function CompanionDock(props: { state: CompanionState; label?: string }) {
  return <div className={styles.slot}><aside className={styles.dock} aria-label="敏的状态"><Companion {...props} caption /></aside></div>;
}
