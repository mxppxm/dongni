"use client";

import { useEffect, useState } from "react";

/**
 * 她等你时的样子：一张 44px 小贴纸 + 一个动作 + 一点小特效。
 * 有哪些样子从服务端拿（她自己新画的也在里面）。
 */
type MoodInfo = { key: string; name: string; url: string; preset: string; fx: string };

let cache: Record<string, MoodInfo> | null = null;
let loading: Promise<Record<string, MoodInfo>> | null = null;

function loadMoods(force = false) {
  if (!force && cache) return Promise.resolve(cache);
  if (!force && loading) return loading;
  loading = fetch("/api/moods")
    .then((r) => r.json())
    .then(({ moods }: { moods: MoodInfo[] }) => (cache = Object.fromEntries(moods.map((m) => [m.key, m]))))
    .catch(() => cache ?? {});
  return loading;
}

const Star = () => (
  <svg viewBox="0 0 24 24">
    <path d="M12 0 C13 7 17 11 24 12 C17 13 13 17 12 24 C11 17 7 13 0 12 C7 11 11 7 12 0 Z" />
  </svg>
);
const Heart = () => (
  <svg viewBox="0 0 24 22">
    <path d="M12 21 C3 14 0 10 1.5 5.5 C3 1 9 0 12 5 C15 0 21 1 22.5 5.5 C24 10 21 14 12 21 Z" />
  </svg>
);
const Note = () => (
  <svg viewBox="0 0 24 24">
    <path d="M9 3v12.5a3.5 3.5 0 1 1-2-3.2V6l12-3v10.5a3.5 3.5 0 1 1-2-3.2V5.6z" />
  </svg>
);

function Fx({ kind }: { kind: string }) {
  switch (kind) {
    case "bubbles":
    case "wind":
    case "drops":
      return (
        <div className={`mood-fx fx-${kind}`}>
          <i />
          <i />
          <i />
        </div>
      );
    case "sparks":
      return (
        <div className="mood-fx fx-sparks">
          <Star />
          <Star />
          <Star />
        </div>
      );
    case "hearts":
      return (
        <div className="mood-fx fx-hearts">
          <Heart />
          <Heart />
        </div>
      );
    case "notes":
      return (
        <div className="mood-fx fx-notes">
          <Note />
          <Note />
        </div>
      );
    case "line":
      return (
        <svg className="mood-fx fx-line" viewBox="0 0 30 18">
          <defs>
            <linearGradient id="mood-ink" x1="0" x2="1">
              <stop offset="0" style={{ stopColor: "var(--chart-1)" }} />
              <stop offset=".5" style={{ stopColor: "var(--chart-3)" }} />
              <stop offset="1" style={{ stopColor: "var(--chart-2)" }} />
            </linearGradient>
          </defs>
          <path d="M2 12 C 6 3, 9 3, 11 9 S 17 16, 20 8 S 26 3, 28 9" />
        </svg>
      );
    default:
      return null;
  }
}

export default function Mood({ mood = "think" }: { mood?: string }) {
  const [moods, setMoods] = useState(cache);
  useEffect(() => {
    // 不认识的 key（她刚画的新样子）就重新拉一次
    if (!cache || !cache[mood]) void loadMoods(!!cache).then(setMoods);
  }, [mood]);
  const m = moods?.[mood] ?? moods?.think;
  if (!m) return <span className="breathe inline-block h-2 w-2 rounded-full bg-[var(--dot)]" />;
  return (
    <span key={m.key} className={`mood mood-${m.preset}`} title={m.name}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={m.url} alt="" draggable={false} />
      <Fx kind={m.fx} />
    </span>
  );
}
