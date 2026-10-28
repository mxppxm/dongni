"use client";

import { useEffect, useRef } from "react";

export type Theme = "dark" | "light";

const PALETTES: Record<Theme, Record<string, string>> = {
  dark: { 人: "#3ad7ff", 偏好: "#b26bff", 经历: "#ffcc4d", 近况: "#4dffb0", 想法: "#ff7a9c" },
  // 浅色底上用更深的同色系，保证看得清
  light: { 人: "#2b9fd8", 偏好: "#8b6cf0", 经历: "#e0951a", 近况: "#18a978", 想法: "#ec5a7a" },
};

export const categoryColors = (theme: Theme) => PALETTES[theme];

type Star = { x: number; y: number; r: number; c: number; vx: number; vy: number; ph: number; flare: number };

/** 背景里极淡的星尘；pulse 变化时随机几颗星亮一下（记住新东西的时候） */
export default function Starfield({ pulse, theme }: { pulse: number; theme: Theme }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stars = useRef<Star[]>([]);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    let w = 0;
    let h = 0;
    let raf = 0;
    const resize = () => {
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    if (!stars.current.length) {
      const n = Math.round(Math.min(160, (w * h) / 9000));
      for (let i = 0; i < n; i++)
        stars.current.push({
          x: Math.random(),
          y: Math.random(),
          r: Math.random() * 1.1 + 0.3,
          c: i % 5,
          vx: (Math.random() - 0.5) * 0.000012,
          vy: (Math.random() - 0.5) * 0.000012,
          ph: Math.random() * 6.28,
          flare: 0,
        });
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const colors = Object.values(PALETTES[themeRef.current]);
      const boost = themeRef.current === "light" ? 1.5 : 1;
      for (const s of stars.current) {
        if (!reduce) {
          s.x = (s.x + s.vx * 16 + 1) % 1;
          s.y = (s.y + s.vy * 16 + 1) % 1;
        }
        s.flare *= 0.985;
        const a = (0.12 + 0.1 * Math.sin(t / 1800 + s.ph)) * boost + s.flare * 0.8;
        const c = colors[s.c];
        const r = s.r * (1 + s.flare * 2.2);
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = c;
        if (s.flare > 0.05) {
          ctx.shadowColor = c;
          ctx.shadowBlur = 14 * s.flare;
        }
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h, r, 0, 6.283);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    if (!pulse) return;
    const list = stars.current;
    for (let i = 0; i < 7 && list.length; i++) list[Math.floor(Math.random() * list.length)].flare = 1;
  }, [pulse]);

  return <canvas ref={ref} className="pointer-events-none fixed inset-0 h-full w-full" aria-hidden />;
}
