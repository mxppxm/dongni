"use client";

import { useEffect, useRef, useState } from "react";
import type { BoopFace } from "@/vendor/boopface/index";
import Companion, { type CompanionState } from "@/components/Companion";

const STATES: { key: CompanionState; label: string }[] = [
  { key: "idle", label: "待机" }, { key: "typing", label: "你在输入" },
  { key: "thinking", label: "思考" }, { key: "working", label: "干活" },
  { key: "success", label: "完成" }, { key: "confused", label: "等你回答" },
  { key: "listening", label: "倾听" }, { key: "speaking", label: "回应" },
];

export default function CompanionPreview() {
  const [state, setState] = useState<CompanionState>("idle");
  const [originalReady, setOriginalReady] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const original = useRef<BoopFace | null>(null);
  useEffect(() => {
    let alive = true;
    let el: BoopFace | null = null;
    import("@/components/minCharacter.js").then(() => {
      if (!alive || !container.current) return;
      el = document.createElement("boop-face") as BoopFace;
      el.setAttribute("skin", "504");
      el.setAttribute("size", "220");
      el.setAttribute("motion", "auto");
      el.setAttribute("aria-label", "BoopFace 原版亮光黄 504");
      original.current = el;
      container.current.appendChild(el);
      setOriginalReady(true);
    });
    return () => { alive = false; el?.remove(); original.current = null; };
  }, []);
  useEffect(() => {
    const el = original.current;
    if (!el || !originalReady) return;
    el.reset();
    const result = state === "thinking" ? el.startWaiting({variant:"wave"})
      : state === "working" ? el.startWaiting({variant:"wrap"})
      : state === "typing" ? el.input(true)
      : state === "success" ? el.play("success")
      : state === "confused" ? el.play("wary")
      : state === "listening" ? el.play("inspect") : undefined;
    void Promise.resolve(result).catch(() => {});
  }, [state, originalReady]);

  return <main className="mx-auto flex min-h-dvh max-w-[920px] flex-col justify-center px-6 py-12 text-[var(--text)]">
    <header className="mb-10 text-center">
      <p className="mb-3 text-xs tracking-[.18em] text-[var(--dim)]">懂你 · 角色工作台</p>
      <h1 className="text-2xl font-medium text-[var(--text-strong)]">让敏真正动起来</h1>
      <p className="mt-3 text-sm text-[var(--dim)]">同一套 BoopFace 交互，原版与自定义形象对照</p>
    </header>
    <div className="grid gap-12 sm:grid-cols-2 sm:gap-10">
      <section className="flex flex-col items-center">
        <div className="flex h-[260px] items-center justify-center"><Companion state={state} size={248} /></div>
        <h2 className="mt-6 text-sm font-medium">敏 · 马尾与绿色卫衣</h2>
        <p className="mt-2 text-xs text-[var(--dim)]">眼睛、眨眼、按压与拖动由 BoopFace 驱动</p>
      </section>
      <section className="flex flex-col items-center">
        <div ref={container} className="flex h-[260px] items-center justify-center" />
        <h2 className="mt-6 text-sm font-medium">原版 · 504 亮光黄</h2>
        <p className="mt-2 text-xs text-[var(--dim)]">保留原始形象，方便比较动作与弹性</p>
      </section>
    </div>
    <nav aria-label="角色状态" className="mx-auto mt-12 flex max-w-[640px] flex-wrap justify-center gap-2">
      {STATES.map((item) => <button key={item.key} aria-pressed={state === item.key} onClick={() => setState(item.key)} className={`rounded-full border px-4 py-2 text-sm transition-colors ${state === item.key ? "border-[var(--dot)] bg-[var(--hover)] text-[var(--text-strong)]" : "border-[var(--border)] text-[var(--dim)] hover:text-[var(--text)]"}`}>{item.label}</button>)}
    </nav>
    <p className="mt-6 text-center text-xs leading-6 text-[var(--dim)]">在角色上移动鼠标、按住脸颊、拖动后松开，试试眼神和回弹。<br />点击敏会打招呼，键盘 Enter / 空格也可以。</p>
    <footer className="mt-10 text-center text-xs text-[var(--dim)]"><a href="/" className="underline underline-offset-4">回到聊天</a><span className="mx-3">·</span><a href="https://github.com/CX-ArtLab/BoopFace" className="underline underline-offset-4">BoopFace / CX ART Lab</a></footer>
  </main>;
}
