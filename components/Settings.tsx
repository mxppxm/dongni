"use client";

import { Settings2 } from "lucide-react";
import { useState } from "react";
import { useVoice } from "./Voice";

/** 设置只有一个开关：回复要不要自动念出来 */
export default function Settings() {
  const { autoplay, setAutoplay } = useVoice();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
        aria-label="设置"
      >
        <Settings2 size={18} strokeWidth={1.6} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-11 right-0 z-30 w-[190px] rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-[var(--shadow)] backdrop-blur-xl">
            <button
              type="button"
              onClick={() => setAutoplay(!autoplay)}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-[13px] text-[var(--text)] transition-colors hover:bg-[var(--hover)]"
            >
              <span>自动念出来</span>
              <span className={`switch ${autoplay ? "switch-on" : ""}`}>
                <span />
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}