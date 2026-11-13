"use client";

import { Puzzle, X } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";

type Plugin = {
  id: string;
  title: string;
  description: string;
  status: "pending" | "disabled" | "needs_key" | "probing" | "failed" | "enabled";
  statusText: string;
  why: string;
  perms: string;
  tools: string[];
  uses: number;
  lastUsedAt: number;
};

/**
 * 「本事」：右上角菜单里的总入口，点开是她后来学会的每一件本事——能不能用、要什么权限、用过几次，旁边一个开关。
 * 新装的本事等他点头：在这儿点「启用」，或者直接跟她说都行。
 */
export default function Plugins({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Plugin[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const { plugins } = (await (await fetch("/api/plugins")).json()) as { plugins: Plugin[] };
      setList(plugins);
    } catch {}
    setLoaded(true);
  }, []);

  const waiting = list.some((p) => p.status === "probing" || p.status === "pending");

  useEffect(() => {
    void load();
    // 有在试跑、在等点头的就勤快点看
    const t = setInterval(() => document.visibilityState === "visible" && load(), waiting ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, waiting]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const act = async (id: string, action: "enable" | "disable") => {
    setBusy(id);
    try {
      const r = (await (
        await fetch("/api/plugins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) })
      ).json()) as { plugins?: Plugin[] };
      if (r.plugins) setList(r.plugins);
    } catch {}
    setBusy("");
  };

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
        aria-label="本事"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6 }}
        transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[380px] rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-[var(--shadow)] backdrop-blur-xl"
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[var(--icon)]">
            <Puzzle size={16} strokeWidth={1.6} />
          </span>
          <span className="flex-1 text-[13px] text-[var(--text)]">本事</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--faint)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
          >
            <X size={14} />
          </button>
        </div>

        {list.length ? (
          <ul className="scroll-thin max-h-[52vh] space-y-0.5 overflow-y-auto overscroll-contain pr-0.5">
            {list.map((p) => {
              const on = p.status !== "pending" && p.status !== "disabled";
              const bad = p.status === "failed" || p.status === "needs_key";
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--hover)]"
                  title={[p.description, p.perms, p.why, p.uses ? `用过 ${p.uses} 次` : ""].filter(Boolean).join("\n")}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] ${on ? "text-[var(--text)]" : "text-[var(--dim)]"}`}>{p.title}</span>
                    <span className={`block truncate text-[11.5px] ${bad ? "text-[#f05252]/80" : "text-[var(--faint)]"}`}>
                      {p.status === "pending" ? `等你点头 · ${p.perms}` : p.why ? `${p.statusText} · ${p.why}` : p.statusText}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy === p.id}
                    onClick={() => void act(p.id, on ? "disable" : "enable")}
                    className="shrink-0 rounded-full bg-[var(--hover)] px-2.5 py-0.5 text-[11.5px] text-[var(--dim)] transition-colors hover:text-[var(--text-strong)] disabled:opacity-40"
                  >
                    {on ? "停用" : "启用"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-1 py-3 text-[12.5px] text-[var(--faint)]">{loaded ? "还没有后来学会的本事" : ""}</p>
        )}
      </motion.div>
    </motion.div>
  );
}
