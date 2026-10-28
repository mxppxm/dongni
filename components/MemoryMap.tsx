"use client";

import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import { AnimatePresence, motion } from "motion/react";
import { Trash2, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { categoryColors, type Theme } from "./Starfield";

type Memory = { id: number; content: string; category: string; createdAt: number; updatedAt: number };
type NodeData = Memory & { deg: number };
type LinkData = { reason: string };
type Node = NodeObject<NodeData>;
type Link = LinkObject<NodeData, LinkData>;
type Data = { profile: string; memories: Memory[]; links: { a: number; b: number; reason: string }[] };

const dateText = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};
const short = (s: string) => (s.length > 14 ? s.slice(0, 13) + "…" : s);
const nid = (x: unknown) => (typeof x === "object" && x ? (x as Node).id : x) as number;

const CANVAS = {
  dark: { label: "rgba(232,244,255,.92)", labelOff: "rgba(232,244,255,.3)", focus: "#ffffff", link: "rgba(120,200,255,.18)", linkOn: "rgba(255,255,255,.6)", linkOff: "rgba(120,200,255,.04)", tagBg: "rgba(26,20,5,.85)", tagFg: "#ffe6a3" },
  light: { label: "rgba(42,36,32,.85)", labelOff: "rgba(42,36,32,.25)", focus: "#231d19", link: "rgba(120,90,60,.18)", linkOn: "rgba(42,36,32,.5)", linkOff: "rgba(120,90,60,.05)", tagBg: "rgba(255,240,226,.97)", tagFg: "#9a4a1e" },
};

export default function MemoryMap({ onClose, theme }: { onClose: () => void; theme: Theme }) {
  const COLORS = categoryColors(theme);
  const K = CANVAS[theme];
  const [data, setData] = useState<Data | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Node | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const fg = useRef<ForceGraphMethods<NodeData, LinkData>>(undefined);

  const load = useCallback(async () => setData(await (await fetch("/api/memories")).json()), []);

  useEffect(() => {
    void load();
    const r = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    r();
    window.addEventListener("resize", r);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
      onClose();
    };
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("resize", r);
      window.removeEventListener("keydown", esc);
    };
  }, [load, onClose]);

  const prevNodes = useRef(new Map<number, Node>());
  const graph = useMemo(() => {
    if (!data) return { nodes: [] as Node[], links: [] as Link[] };
    const deg = new Map<number, number>();
    for (const l of data.links) {
      deg.set(l.a, (deg.get(l.a) ?? 0) + 1);
      deg.set(l.b, (deg.get(l.b) ?? 0) + 1);
    }
    return {
      // 沿用旧坐标，删一条记忆时星图不会整个重排
      nodes: data.memories.map((m) => {
        const old = prevNodes.current.get(m.id);
        const n = { ...m, deg: deg.get(m.id) ?? 0, x: old?.x, y: old?.y, vx: old?.vx, vy: old?.vy } as Node;
        return n;
      }),
      links: data.links.map((l) => ({ source: l.a, target: l.b, reason: l.reason })) as Link[],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.memories, data?.links]);
  useEffect(() => {
    prevNodes.current = new Map(graph.nodes.map((n) => [n.id as number, n]));
  }, [graph]);

  const neighbors = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const l of data?.links ?? []) {
      if (!map.has(l.a)) map.set(l.a, new Set());
      if (!map.has(l.b)) map.set(l.b, new Set());
      map.get(l.a)!.add(l.b);
      map.get(l.b)!.add(l.a);
    }
    return map;
  }, [data]);

  useEffect(() => {
    fg.current?.d3Force("charge")?.strength(-90);
    fg.current?.d3Force("link")?.distance(60);
  }, [graph]);

  const focus = hover ?? selected;
  const lit = useMemo(() => {
    if (!focus) return null;
    return new Set([focus.id, ...(neighbors.get(focus.id) ?? [])]);
  }, [focus, neighbors]);

  const drawNode = useCallback(
    (node: Node, ctx: CanvasRenderingContext2D, scale: number) => {
      const c = COLORS[node.category] ?? "#9fb3c8";
      const on = !lit || lit.has(node.id);
      const isFocus = focus?.id === node.id;
      const r = (2.6 + Math.min(node.deg, 8) * 0.45) * (isFocus ? 1.5 : 1);
      ctx.globalAlpha = on ? 1 : 0.18;
      ctx.shadowColor = c;
      ctx.shadowBlur = (isFocus ? 26 : 12) * (theme === "light" ? 0.5 : 1);
      ctx.fillStyle = isFocus ? K.focus : c;
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (isFocus) {
        ctx.strokeStyle = c;
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, r + 5, 0, 2 * Math.PI);
        ctx.stroke();
      }
      // 缩放够大或相关时才显示文字，保持干净
      if (scale > 1.6 || (lit && on)) {
        const fs = 11 / scale;
        ctx.font = `${isFocus ? 600 : 400} ${fs}px "PingFang SC", sans-serif`;
        ctx.fillStyle = on ? K.label : K.labelOff;
        ctx.textBaseline = "middle";
        ctx.fillText(short(node.content), node.x! + r + 4 / scale, node.y!);
      }
      ctx.globalAlpha = 1;
    },
    [lit, focus, COLORS, K, theme],
  );

  const drawLinkLabel = useCallback(
    (link: Link, ctx: CanvasRenderingContext2D, scale: number) => {
      if (!focus || !link.reason) return;
      const s = link.source as Node;
      const t = link.target as Node;
      if (s.id !== focus.id && t.id !== focus.id) return;
      const x = (s.x! + t.x!) / 2;
      const y = (s.y! + t.y!) / 2;
      const fs = 10 / scale;
      ctx.font = `${fs}px "PingFang SC", sans-serif`;
      const w = ctx.measureText(link.reason).width + 10 / scale;
      ctx.fillStyle = K.tagBg;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - fs * 0.85, w, fs * 1.7, fs * 0.85);
      ctx.fill();
      ctx.fillStyle = K.tagFg;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(link.reason, x, y);
      ctx.textAlign = "start";
    },
    [focus, K],
  );

  const linkColor = useCallback(
    (l: Link) => {
      if (!focus) return K.link;
      const on = nid(l.source) === focus.id || nid(l.target) === focus.id;
      return on ? K.linkOn : K.linkOff;
    },
    [focus, K],
  );

  const saveMemory = async (id: number, content: string) => {
    await fetch(`/api/memories/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
    // 原地改，不触发星图重排
    const n = graph.nodes.find((x) => x.id === id);
    if (n) n.content = content;
    const m = data?.memories.find((x) => x.id === id);
    if (m) m.content = content;
  };
  const removeMemory = async (id: number) => {
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    setSelected(null);
    setData((d) => d && { ...d, memories: d.memories.filter((m) => m.id !== id), links: d.links.filter((l) => l.a !== id && l.b !== id) });
  };
  const saveProfile = async (profile: string) => {
    await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile }) });
    setData((d) => d && { ...d, profile });
  };

  const legend = useMemo(() => {
    const used = new Set(data?.memories.map((m) => m.category));
    return Object.entries(COLORS).filter(([k]) => used.has(k));
  }, [data, COLORS]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 1.03 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.03 }}
      transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
      className="fixed inset-0 z-30 bg-[image:var(--map-bg)]"
    >
      {size.w > 0 && data && data.memories.length > 0 && (
        <ForceGraph2D<NodeData, LinkData>
          ref={fg}
          width={size.w}
          height={size.h}
          graphData={graph}
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={5}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={(n, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x!, n.y!, 8, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={linkColor}
          linkWidth={(l) => (focus && (nid(l.source) === focus.id || nid(l.target) === focus.id) ? 1.4 : 0.7)}
          linkDirectionalParticles={(l) => (focus && (nid(l.source) === focus.id || nid(l.target) === focus.id) ? 2 : 0)}
          linkDirectionalParticleWidth={2}
          linkDirectionalParticleColor={() => K.focus}
          linkCanvasObjectMode={() => "after"}
          linkCanvasObject={drawLinkLabel}
          onNodeHover={(n) => setHover(n)}
          onNodeClick={(n) => {
            setSelected(n);
            fg.current?.centerAt(n.x, n.y, 600);
          }}
          onBackgroundClick={() => setSelected(null)}
          cooldownTicks={200}
          onEngineStop={() => {
            if (!selected) fg.current?.zoomToFit(600, 80);
          }}
        />
      )}

      {data && data.memories.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--faint)]">还没有记忆</div>
      )}

      <div className="absolute top-4 right-4 flex gap-1">
        <button
          onClick={() => setShowProfile((v) => !v)}
          className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-[var(--hover)] ${showProfile ? "text-[var(--text-strong)]" : "text-[var(--icon)] hover:text-[var(--icon-hover)]"}`}
          aria-label="画像"
          title="我眼中的你"
        >
          <UserRound size={18} strokeWidth={1.6} />
        </button>
        <button
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--icon)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--icon-hover)]"
          aria-label="关闭"
        >
          <X size={20} strokeWidth={1.6} />
        </button>
      </div>

      {legend.length > 0 && (
        <div className="absolute bottom-5 left-5 flex gap-4 text-xs text-[var(--dim)] select-none">
          {legend.map(([k, c]) => (
            <span key={k} className="flex items-center gap-1.5">
              <i className="inline-block h-2 w-2 rounded-full" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
              {k}
            </span>
          ))}
        </div>
      )}

      <AnimatePresence>
        {showProfile && data && (
          <motion.div
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.3 }}
            className="absolute top-4 bottom-16 left-4 flex w-[min(420px,calc(100vw-32px))] flex-col rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[var(--shadow)] backdrop-blur-xl"
          >
            <div className="mb-3 text-xs tracking-widest text-[var(--dim)]">我眼中的你</div>
            <Editable
              key={data.profile}
              value={data.profile}
              placeholder="多聊几句，这里会慢慢写满"
              onSave={saveProfile}
              className="scroll-thin flex-1 text-[15px] leading-[1.9] text-[var(--text)]"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selected && (
          <motion.div
            key={selected.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.25 }}
            className="absolute right-5 bottom-5 w-[min(340px,calc(100vw-40px))] rounded-2xl border bg-[var(--panel)] p-4 shadow-[var(--shadow)] backdrop-blur-xl"
            style={{ borderColor: (COLORS[selected.category] ?? "#9fb3c8") + "66" }}
          >
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--dim)]">
              <span style={{ color: COLORS[selected.category] }}>{selected.category}</span>
              <span>{dateText(selected.createdAt)}</span>
            </div>
            <Editable
              key={selected.id}
              value={data?.memories.find((m) => m.id === selected.id)?.content ?? selected.content}
              onSave={(v) => saveMemory(selected.id, v)}
              className="text-[15px] leading-relaxed text-[var(--text)]"
            />
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-[var(--faint)]">{neighbors.get(selected.id)?.size ?? 0} 条关联</span>
              <DeleteButton onConfirm={() => removeMemory(selected.id)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** 直接点进去改，失焦自动保存 */
function Editable({
  value,
  onSave,
  className,
  placeholder,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = ref.current;
    if (!ta || ta.classList.contains("flex-1")) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [v]);
  return (
    <textarea
      ref={ref}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== value.trim() && v.trim() && onSave(v.trim())}
      className={`w-full resize-none bg-transparent outline-none placeholder:text-[var(--faint)] ${className ?? ""}`}
      rows={1}
    />
  );
}

function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      className={`flex h-8 items-center gap-1 rounded-full px-2.5 text-xs transition-colors ${
        armed ? "bg-rose-500/15 text-rose-400" : "text-[var(--icon)] hover:text-[var(--icon-hover)]"
      }`}
      aria-label="删除这条记忆"
    >
      <Trash2 size={14} />
      {armed && "再点一次删除"}
    </button>
  );
}
