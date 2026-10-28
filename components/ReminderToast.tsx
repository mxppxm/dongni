"use client";

import { AnimatePresence, motion } from "motion/react";
import { Bell, X } from "lucide-react";
import { useEffect } from "react";

/** 到点的提醒：顶部轻轻落下来一张小卡片，点一下就收走 */
export default function ReminderToast({
  reminder,
  onClose,
}: {
  reminder: { id: number; text: string } | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!reminder) return;
    const t = setTimeout(onClose, 15000);
    return () => clearTimeout(t);
  }, [reminder, onClose]);

  return (
    <div className="pointer-events-none fixed top-16 left-1/2 z-30 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2">
      <AnimatePresence>
        {reminder && (
          <motion.div
            key={reminder.id}
            initial={{ opacity: 0, y: -14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 340, damping: 26 }}
            className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] py-3 pr-2 pl-3.5 shadow-[var(--shadow)] backdrop-blur-xl"
          >
            <span className="breathe flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--bubble)] text-[var(--dot)]">
              <Bell size={16} strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1 text-[15px] leading-snug break-words text-[var(--text)]">{reminder.text}</span>
            <button
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
              aria-label="关闭提醒"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}