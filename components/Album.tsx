"use client";

import { motion } from "motion/react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

/** 相册（按日期攒，日期倒序，能翻回以前的每一天）和衣橱（几套固定造型，今天穿哪套） */
type Outfit = { key: string; name: string; when: string; url: string | null };
type Photo = {
  id: number;
  date: string;
  outfit: string;
  weather: string;
  caption: string;
  diary: string | null;
  created_at: number;
  url: string;
  kind?: string;
};
type Data = { today: { outfit: string }; outfits: Outfit[]; photos: Photo[] };

const dateText = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  const w = "日一二三四五六"[new Date(y, m - 1, day).getDay()];
  return `${m}月${day}日 · 周${w}`;
};

/** 同一天拍了好几张时，补上时刻，才分得清哪张是哪张 */
const timeText = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export default function Album({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<"album" | "wardrobe">("album");
  const [zoom, setZoom] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/album")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (zoom ? setZoom(null) : onClose());
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, zoom]);

  const days = (() => {
    const out: { date: string; photos: Photo[] }[] = [];
    for (const p of data?.photos ?? []) {
      const last = out[out.length - 1];
      if (last && last.date === p.date) last.photos.push(p);
      else out.push({ date: p.date, photos: [p] });
    }
    return out;
  })();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 1.02 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.02 }}
      transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
      className="fixed inset-0 z-30 overflow-y-auto bg-[var(--bg)] scroll-thin"
    >
      <div className="pointer-events-none fixed inset-0 bg-[image:var(--glow-bg)]" />
      <div className="relative mx-auto max-w-[920px] px-6 pt-8 pb-20">
        <div className="mb-8 flex items-center gap-1">
          {(["album", "wardrobe"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
                tab === t ? "bg-[var(--bubble)] text-[var(--text-strong)] shadow-[var(--bubble-shadow)]" : "text-[var(--dim)] hover:text-[var(--text)]"
              }`}
            >
              {t === "album" ? "相册" : "衣橱"}
            </button>
          ))}
          <button
            onClick={onClose}
            className="ml-auto flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
            aria-label="关闭"
          >
            <X size={20} strokeWidth={1.6} />
          </button>
        </div>

        {data && tab === "album" &&
          (days.length ? (
            days.map((g) => (
              <section key={g.date} className="album-day">
                <h3 className="album-day-title">{dateText(g.date)}</h3>
                {g.photos.find((p) => p.diary)?.diary && <p className="album-day-diary">{g.photos.find((p) => p.diary)!.diary}</p>}
                <div className="album-grid">
                  {g.photos.map((p, i) => {
                    const meta = [g.photos.length > 1 ? timeText(p.created_at) : "", p.weather, p.outfit].filter(Boolean).join(" · ");
                    return (
                      <motion.figure
                        key={p.id}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i, 8) * 0.05 }}
                        className="polaroid"
                        style={{ rotate: `${((i * 37) % 5) - 2}deg` }}
                        onClick={() => setZoom(p.url)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.url} alt="" loading="lazy" style={p.kind === "drawn" ? { aspectRatio: "auto" } : undefined} />
                        <figcaption>
                          {p.caption && <span className="pc-caption">{p.caption}</span>}
                          <span className="pc-meta">{meta}</span>
                        </figcaption>
                      </motion.figure>
                    );
                  })}
                </div>
              </section>
            ))
          ) : (
            <p className="mt-24 text-center text-sm text-[var(--faint)]">还没有照片</p>
          ))}

        {data && tab === "wardrobe" && (
          <div className="wardrobe-grid">
            {data.outfits.map((o) => (
              <div key={o.key} className={`outfit ${data.today.outfit === o.key ? "outfit-now" : ""}`} onClick={() => o.url && setZoom(o.url)}>
                <div className="outfit-img">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {o.url ? <img src={o.url} alt="" loading="lazy" /> : <span className="breathe inline-block h-2 w-2 rounded-full bg-[var(--dot)]" />}
                </div>
                <div className="outfit-name">
                  {o.name}
                  {data.today.outfit === o.key && <em>今天</em>}
                </div>
                <div className="outfit-when">{o.when}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {zoom && (
        <div className="img-zoom" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="" />
        </div>
      )}
    </motion.div>
  );
}
