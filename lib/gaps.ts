import "server-only";
import { getKv, setKv } from "./db";

/**
 * 做不到清单：他让她做、她确实做不了的事，记一笔。
 * 只是记账——加不加这件本事由他定（他说加，她再去派活或改自己）；她不会自己照着这张单子动手。
 */
export type Gap = { id: number; what: string; at: number; times: number; done?: boolean };
const KEY = "capability_gaps";
const KEEP = 60;

function all(): Gap[] {
  try {
    return JSON.parse(getKv(KEY) || "[]") as Gap[];
  } catch {
    return [];
  }
}

/** 字二元组重合：同一件事换个说法再记，只加次数不加条目 */
function alike(a: string, b: string) {
  const grams = (t: string) => {
    const s = t.replace(/[\s\p{P}\p{S}]/gu, "");
    const g = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const x = grams(a);
  const y = grams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const k of x) if (y.has(k)) both++;
  return both / Math.min(x.size, y.size);
}

export function noteGap(what: string): Gap {
  const text = what.trim().replace(/\s+/g, " ").slice(0, 200);
  const list = all();
  const same = list.find((g) => !g.done && alike(g.what, text) >= 0.6);
  if (same) {
    same.times++;
    same.at = Date.now();
    setKv(KEY, JSON.stringify(list));
    return same;
  }
  const gap: Gap = { id: (list.at(-1)?.id ?? 0) + 1, what: text, at: Date.now(), times: 1 };
  setKv(KEY, JSON.stringify([...list, gap].slice(-KEEP)));
  return gap;
}

export function openGaps(): Gap[] {
  return all().filter((g) => !g.done);
}

export function closeGap(id: number): Gap | null {
  const list = all();
  const g = list.find((x) => x.id === id && !x.done);
  if (!g) return null;
  g.done = true;
  setKv(KEY, JSON.stringify(list));
  return g;
}
