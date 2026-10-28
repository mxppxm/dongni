"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** 对话里的图片：加载失败给个占位，点开看大图 */
export default function ImageFigure({ src, alt }: { src: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (failed) return <span className="md-img-fail">这张图打不开</span>;

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt || ""} loading="lazy" className="md-img" onClick={() => setOpen(true)} onError={() => setFailed(true)} />
      {open &&
        createPortal(
          <div className="img-zoom" onClick={() => setOpen(false)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={alt || ""} />
            <button type="button" className="img-zoom-close" aria-label="关闭">
              <X size={16} strokeWidth={2} />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}