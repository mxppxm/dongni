"use client";

import { useEffect, useState } from "react";

type Balance = { amount: number | null; stale?: boolean; off?: boolean };

/** 左边任务栏顶上那行小字：DS 余额，一分钟看一眼；取不到就留着上次的数字、变暗，不出声 */
export default function Balance() {
  const [amount, setAmount] = useState<number | null>(null);
  const [dim, setDim] = useState(false);
  const [off, setOff] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const d = (await (await fetch("/api/balance", { cache: "no-store" })).json()) as Balance;
        if (!alive) return;
        setOff(!!d.off);
        if (typeof d.amount === "number") {
          setAmount(d.amount);
          setDim(!!d.stale);
        } else setDim(true);
      } catch {
        if (alive) setDim(true);
      }
    };
    void tick();
    const t = setInterval(tick, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (off) return null;
  return (
    <div
      className={`shrink-0 px-2 pb-1.5 text-[11px] text-[var(--faint)] tabular-nums select-none transition-opacity duration-500 ${
        dim ? "opacity-40" : ""
      }`}
    >
      {amount == null ? "余额 —" : `余额 ¥${amount.toFixed(2)}`}
    </div>
  );
}
