"use client";

import { AnimatePresence, motion } from "motion/react";
import { BookHeart, Cpu, LayoutGrid, Moon, Phone, Sparkles, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Theme } from "./Starfield";
import { useVoice } from "./Voice";

type Models = { active: string; profiles: { id: string; label: string; model: string }[] };

/**
 * 右上角只留一个按钮，点开是一块浮窗：打电话 / 记忆 / 相册三个入口，
 * 下面是自动念、深色、模型线路三个设置。以前五个图标排一排，太挤。
 */
export default function Dock({
  theme,
  onToggleTheme,
  onCall,
  calling,
  onMap,
  onAlbum,
  memCount,
  pulse,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onCall: () => void;
  calling: boolean;
  onMap: () => void;
  onAlbum: () => void;
  memCount: number | null;
  pulse: number;
}) {
  const { autoplay, setAutoplay } = useVoice();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<Models | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const loadModels = useCallback(async () => {
    try {
      const r = await fetch("/api/model", { cache: "no-store" });
      if (r.ok) setModels((await r.json()) as Models);
    } catch {}
  }, []);

  useEffect(() => {
    if (open) void loadModels();
  }, [open, loadModels]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pickModel = async (id: string) => {
    if (!models || id === models.active || switching) return;
    setSwitching(id);
    try {
      const r = await fetch("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (r.ok) setModels((await r.json()) as Models);
    } catch {
    } finally {
      setSwitching(null);
    }
  };

  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const active = models?.profiles.find((p) => p.id === models.active);

  return (
    <div ref={box} className="fixed top-4 right-4 z-20">
      <motion.button
        key={pulse}
        type="button"
        onClick={() => setOpen((v) => !v)}
        initial={pulse ? { scale: 1.35, boxShadow: "0 0 28px 6px rgba(58,215,255,.55)" } : false}
        animate={{ scale: 1, boxShadow: "0 0 0px 0px rgba(58,215,255,0)" }}
        transition={{ duration: 1.4, ease: "easeOut" }}
        className={`relative flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)] ${
          open ? "bg-[var(--hover)] text-[var(--icon-hover)]" : "text-[var(--icon)]"
        }`}
        aria-label="菜单"
        aria-expanded={open}
        title="打电话 · 记忆 · 相册 · 设置"
      >
        <LayoutGrid size={18} strokeWidth={1.6} />
        {calling && <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-emerald-400" />}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            style={{ transformOrigin: "top right" }}
            className="absolute top-12 right-0 w-[264px] rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-[var(--shadow)] backdrop-blur-xl"
          >
            <div className="grid grid-cols-3 gap-1.5">
              <Tile icon={<Phone size={18} strokeWidth={1.6} />} label={calling ? "回到电话" : "打电话"} onClick={go(onCall)} on={calling} />
              <Tile
                icon={<Sparkles size={18} strokeWidth={1.6} />}
                label="记忆"
                sub={memCount !== null ? `${memCount} 条` : undefined}
                onClick={go(onMap)}
              />
              <Tile icon={<BookHeart size={18} strokeWidth={1.6} />} label="相册" sub="和衣橱" onClick={go(onAlbum)} />
            </div>

            <div className="my-2 h-px bg-[var(--border)]" />

            <Row icon={<Volume2 size={15} strokeWidth={1.6} />} label="自动念出来" on={autoplay} onClick={() => setAutoplay(!autoplay)} />
            <Row icon={<Moon size={15} strokeWidth={1.6} />} label="深色" on={theme === "dark"} onClick={onToggleTheme} />

            {models && models.profiles.length > 1 && (
              <div className="mt-1 px-2 pt-1.5 pb-1">
                <div className="mb-1.5 flex items-center gap-2 text-[13px] text-[var(--text)]">
                  <span className="text-[var(--icon)]">
                    <Cpu size={15} strokeWidth={1.6} />
                  </span>
                  <span className="flex-1">模型</span>
                  <span className="truncate text-[11px] text-[var(--faint)]" title={active?.model}>
                    {active?.model}
                  </span>
                </div>
                <div className="flex rounded-xl bg-[var(--hover)] p-0.5">
                  {models.profiles.map((p) => {
                    const on = p.id === models.active;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => void pickModel(p.id)}
                        disabled={!!switching}
                        className={`relative flex-1 rounded-[10px] py-1 text-[12.5px] transition-colors ${
                          on ? "text-[var(--text-strong)]" : "text-[var(--dim)] hover:text-[var(--text)]"
                        }`}
                        title={p.model}
                      >
                        {on && (
                          <motion.span
                            layoutId="model-pill"
                            className="absolute inset-0 rounded-[10px] bg-[var(--panel)] shadow-[0_1px_4px_rgba(0,0,0,0.12)]"
                            transition={{ duration: 0.2 }}
                          />
                        )}
                        <span className={`relative ${switching === p.id ? "opacity-50" : ""}`}>{p.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Tile({ icon, label, sub, onClick, on }: { icon: React.ReactNode; label: string; sub?: string; onClick: () => void; on?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2.5 transition-colors hover:bg-[var(--hover)] ${
        on ? "text-emerald-500" : "text-[var(--text)]"
      }`}
    >
      <span className={on ? "" : "text-[var(--icon-hover)]"}>{icon}</span>
      <span className="text-[12.5px] leading-none">{label}</span>
      <span className="h-3 text-[10.5px] leading-none text-[var(--faint)] tabular-nums">{sub}</span>
    </button>
  );
}

function Row({ icon, label, on, onClick }: { icon: React.ReactNode; label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-[13px] text-[var(--text)] transition-colors hover:bg-[var(--hover)]"
    >
      <span className="text-[var(--icon)]">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      <span className={`relative h-[18px] w-[30px] rounded-full transition-colors ${on ? "bg-emerald-500/80" : "bg-[var(--faint)]"}`}>
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left] duration-200 ${on ? "left-[14px]" : "left-[2px]"}`}
        />
      </span>
    </button>
  );
}
