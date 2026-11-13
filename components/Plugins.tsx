"use client";

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
 * 「本事」：她后来学会的每件本事列在这儿——能不能用、要什么权限、用过几次，旁边一个开关。
 * 一件都没有的时候整块不出现。新装的本事等他点头：在这儿点「启用」，或者直接跟她说都行。
 */
export default function Plugins() {
  const [list, setList] = useState<Plugin[]>([]);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const { plugins } = (await (await fetch("/api/plugins")).json()) as { plugins: Plugin[] };
      setList(plugins);
    } catch {}
  }, []);

  const waiting = list.some((p) => p.status === "probing" || p.status === "pending");

  useEffect(() => {
    void load();
    // 有在试跑、在等点头的就勤快点看
    const t = setInterval(() => document.visibilityState === "visible" && load(), waiting ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, waiting]);

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

  if (!list.length) return null;

  return (
    <div className="mt-3 shrink-0">
      <div className="mb-2 px-2 text-xs tracking-wide text-[var(--faint)] select-none">本事</div>
      <ul className="scroll-thin max-h-[32vh] space-y-0.5 overflow-y-auto overscroll-contain pr-0.5">
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
    </div>
  );
}
