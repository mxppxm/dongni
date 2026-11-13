"use client";

import { CloudSun, X } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

type Card = { title: string; rows: [string, string][] };

const CITY_KEY = "dongni:weather-city";

/**
 * 查天气：右上角菜单里点开，填个城市，看她那件「查天气」本事查回来的现在和未来三天。
 * 上次查过的城市记着，下次点开直接查那个。
 */
export default function Weather({ onClose }: { onClose: () => void }) {
  const [city, setCity] = useState("");
  const [data, setData] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const touched = useRef(false);

  const look = useCallback(async (name: string) => {
    const n = name.trim();
    if (!n) return;
    const mine = ++seq.current;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/weather", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: n }),
      });
      const j = (await r.json()) as { city?: string; card?: Card; error?: string };
      if (mine !== seq.current) return;
      if (!r.ok || j.error || !j.card) {
        setData(null);
        setError(j.error || "没查到，过会儿再试");
        return;
      }
      setData(j.card);
      setCity(n);
      try {
        localStorage.setItem(CITY_KEY, n);
      } catch {}
    } catch {
      if (mine !== seq.current) return;
      setData(null);
      setError("网络没连上，没查到");
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    input.current?.focus();
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(CITY_KEY);
    } catch {}
    if (saved) {
      setCity(saved);
      void look(saved);
      return;
    }
    // 头一回用：她平时在哪个城市就查哪个
    let stop = false;
    (async () => {
      try {
        const j = (await (await fetch("/api/weather", { cache: "no-store" })).json()) as { city?: string };
        if (stop || touched.current || !j.city) return;
        setCity(j.city);
        void look(j.city);
      } catch {}
    })();
    return () => {
      stop = true;
    };
  }, [look]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 px-5 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-label="查天气"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6 }}
        transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-[var(--shadow)] backdrop-blur-xl"
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[var(--icon)]">
            <CloudSun size={16} strokeWidth={1.6} />
          </span>
          <span className="flex-1 text-[13px] text-[var(--text)]">查天气</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
          >
            <X size={14} />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void look(city);
          }}
          className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--hover)] px-3 py-1.5"
        >
          <input
            ref={input}
            value={city}
            onChange={(e) => {
              touched.current = true;
              setCity(e.target.value);
            }}
            placeholder="城市，比如北京"
            className="min-w-0 flex-1 bg-transparent py-1 text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--faint)]"
          />
          <button
            type="submit"
            disabled={busy || !city.trim()}
            className="shrink-0 rounded-full px-2 py-0.5 text-[12px] text-[var(--dim)] transition-colors hover:text-[var(--text-strong)] disabled:opacity-40"
          >
            {busy ? "查着…" : "查一下"}
          </button>
        </form>

        {error ? (
          <p className="mt-4 text-[12.5px] leading-relaxed text-[#f05252]/80">{error}</p>
        ) : data ? (
          <div className="card card-info mt-3">
            <span className="card-icon">
              <CloudSun size={16} strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="card-title">{data.title}</span>
              <span className="card-rows">
                {data.rows.map((r, i) => (
                  <span key={i} className="card-row">
                    <span className="card-row-k">{r[0]}</span>
                    <span className="card-row-v">{r[1]}</span>
                  </span>
                ))}
              </span>
            </span>
          </div>
        ) : busy ? (
          <p className="mt-5 text-center text-[12.5px] text-[var(--faint)]">正在查…</p>
        ) : null}
      </motion.div>
    </motion.div>
  );
}
