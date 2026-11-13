import fs from "node:fs";
import path from "node:path";

/**
 * 衣橱的造型清单。
 *
 * 以前整份清单写死在代码里（模块加载时读进内存），加一件衣服就得重新构建、重启才认。
 * 现在清单以 data/wardrobe/outfits.json 为准，每次读衣橱都重新读一遍文件，不缓存旧数据——
 * 往文件里加一件、改一件，下一次读就生效，不用重启。
 *
 * 文件格式：一个数组（也可以写成 {"outfits": [...]}），每一项：
 *   { "key": "snow", "name": "雪天那身", "when": "下雪的日子", "wear": "英文描述她穿什么",
 *     "real": true,
 *     "rule": { "hours": [8, 18], "tempMax": 2, "kinds": ["snow"], "months": [11, 3], "priority": 5 } }
 * key 只用字母数字下划线横线（它同时是定妆照的文件名），name、wear 新加的那件必填。
 * rule 可选：写了就按条件选它（条件都满足才穿），优先级比下面写死的规则高，priority 大的先穿；
 * 不写 rule 的衣服只能靠内置规则或手动指定才会被穿到。文件里同 key 的项覆盖内置那套（可以只写改动的字段）。
 * 内置的几套是默认值，文件不存在、读坏了都不影响她穿衣。
 */

const ROOT = process.cwd();
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(ROOT, "data");
/** 定妆照、相册照片、清单文件都放这儿 */
export const WARDROBE_DIR = path.join(DATA_DIR, "wardrobe");
const OUTFITS_FILE = () => path.join(WARDROBE_DIR, "outfits.json");

export type WeatherKind = "sun" | "cloud" | "rain" | "snow" | "unknown";

/** 从 outfits.json 加的衣服可以带条件；条件都满足就穿它 */
export type OutfitRule = {
  /** 几点到几点，含头不含尾；跨夜写 [22, 6] */
  hours?: [number, number];
  /** 体感温度不低于 / 不高于（°C） */
  tempMin?: number;
  tempMax?: number;
  /** 天气是其中一种 */
  kinds?: WeatherKind[];
  /** 几月到几月，含头不含尾；跨年写 [11, 3] */
  months?: [number, number];
  /** 同时满足好几身时，数大的先穿（不写算 0） */
  priority?: number;
};

export type Outfit = {
  key: string;
  name: string;
  when: string;
  wear: string;
  /** 定妆照要真照片感，不用 3D 渲染那套 */
  real?: boolean;
  rule?: OutfitRule;
};

/** 几套固定造型（衣服定死，每次都穿得一模一样） */
export const BUILTIN_OUTFITS: Outfit[] = [
  { key: "sunny", name: "晴天亮色", when: "晴天、多云，不冷不热的白天", wear: "a mint-green oversized hoodie, light denim shorts, white sneakers with mint laces" },
  { key: "rainy", name: "雨天灰调", when: "下雨、下雪、阴沉的天", wear: "a soft grey hooded raincoat over a cream knit sweater, dark grey jeans, glossy black rain boots, holding a clear umbrella" },
  { key: "cold", name: "冷天外套", when: "气温低于 12°C", wear: "a camel wool duffle coat, a chunky cream scarf, a brown knit beanie, dark jeans, brown lace-up ankle boots" },
  { key: "run", name: "跑步那身", when: "清晨 6–8 点，天不下雨", wear: "an orange zip running jacket, black running leggings, a white cap, neon running shoes, a sports watch" },
  { key: "home", name: "夜里窝着", when: "晚上 10 点以后到早上 7 点", wear: "a loose oatmeal cardigan over lavender pajamas with tiny star prints, fluffy white slippers" },
  { key: "indoor", name: "窝着的下午", when: "白天 10°C 以下的室内日子", wear: "杏色粗针织开衫配白圆领T，深棕格纹A字裙，厚羊毛连裤袜，米白软底家居拖鞋", real: true },
  { key: "leaf", name: "出门踩叶子", when: "冷天出门 3–8°C 晴或多云", wear: "奶白短羽绒服、灰蓝连帽卫衣、直筒牛仔裤、燕麦色粗针织围巾、白色帆布鞋", real: true },
  { key: "evening", name: "晚上有点讲究", when: "18 点以后出门", wear: "墨绿丝绒连衣裙、黑色薄开衫、细金项链、黑色短靴", real: true },
  {
    key: "library",
    name: "阴天的图书馆",
    when: "秋季阴天、5~12°C 的白天到傍晚",
    wear: "深灰色高领薄毛衣，外搭卡其色长风衣（敞开穿），深蓝色直筒牛仔裤，棕色短靴",
    real: true,
    rule: { hours: [8, 19], tempMin: 5, tempMax: 12, kinds: ["cloud"], months: [9, 12], priority: 5 },
  },
];

/** key 同时是定妆照文件名，统一成安全的短名 */
const KEY = /^[A-Za-z0-9_-]{1,32}$/;
const KINDS: WeatherKind[] = ["sun", "cloud", "rain", "snow", "unknown"];

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function parseRule(raw: unknown): OutfitRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: OutfitRule = {};
  if (Array.isArray(r.hours)) {
    const a = num(r.hours[0]);
    const b = num(r.hours[1]);
    if (a !== undefined && b !== undefined && a >= 0 && b >= 0 && a <= 24 && b <= 24) out.hours = [a, b];
  }
  if (Array.isArray(r.months)) {
    const a = num(r.months[0]);
    const b = num(r.months[1]);
    if (a !== undefined && b !== undefined && a >= 1 && b >= 1 && a <= 12 && b <= 12) out.months = [a, b];
  }
  const min = num(r.tempMin);
  const max = num(r.tempMax);
  if (min !== undefined) out.tempMin = min;
  if (max !== undefined) out.tempMax = max;
  if (Array.isArray(r.kinds)) {
    const kinds = r.kinds.filter((k): k is WeatherKind => typeof k === "string" && KINDS.includes(k as WeatherKind));
    if (kinds.length) out.kinds = kinds;
  }
  const pri = num(r.priority);
  if (pri !== undefined) out.priority = pri;
  return Object.keys(out).length ? out : undefined;
}

/** 一条文件里的记录 → 合法的造型（新加的必填 name + wear；覆盖内置的可以只写改动的字段） */
function parseEntry(raw: unknown): Partial<Outfit> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const key = str(o.key, 32);
  if (!key || !KEY.test(key)) return null;
  const out: Partial<Outfit> = { key };
  const name = str(o.name, 40);
  const wear = str(o.wear, 600);
  if (name) out.name = name;
  if (wear) out.wear = wear;
  const when = str(o.when, 80);
  if (when) out.when = when;
  if (typeof o.real === "boolean") out.real = o.real;
  const rule = parseRule(o.rule);
  if (rule) out.rule = rule;
  return out;
}

/** 文件里的项：同 key 覆盖内置的，新 key 排在后面；缺字段的沿用内置那份 */
function merge(entries: Partial<Outfit>[]): Outfit[] {
  const list = BUILTIN_OUTFITS.map((o) => ({ ...o }));
  const at = new Map(list.map((o, i) => [o.key, i]));
  for (const e of entries) {
    const i = at.get(e.key!);
    if (i === undefined) {
      if (!e.name || !e.wear) continue; // 新加的那件得说清叫什么、穿什么
      at.set(e.key!, list.length);
      list.push({ key: e.key!, name: e.name, when: e.when ?? "", wear: e.wear, real: e.real, rule: e.rule });
    } else {
      const old = list[i];
      list[i] = { ...old, ...e, key: old.key, name: e.name ?? old.name, when: e.when ?? old.when, wear: e.wear ?? old.wear };
    }
  }
  return list;
}

/** 上一次读到的文件内容；内容没变就直接返回上次那份，变了就马上重新解析，不留旧数据 */
let cache: { file: string; exists: boolean; text: string; list: Outfit[] } | null = null;
/** 清单每换一次内容加一：用来判断「是不是新加了衣服，该补定妆照了」 */
let version = 0;

export function outfitsVersion() {
  outfits();
  return version;
}

/** 读衣橱清单：每次都重新读文件（文件很小），所以加衣服、改衣服下一次读就生效，不用重启 */
export function outfits(): Outfit[] {
  const file = OUTFITS_FILE();
  let exists = false;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
    exists = true;
  } catch {
    /* 文件还没建（或读不了）：只用内置那几套 */
  }
  if (cache && cache.file === file && cache.exists === exists && cache.text === text) return cache.list;
  const first = !cache;
  const entries: Partial<Outfit>[] = [];
  if (exists) {
    try {
      const raw = JSON.parse(text) as unknown;
      const arr = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { outfits?: unknown })?.outfits)
          ? (raw as { outfits: unknown[] }).outfits
          : null;
      if (!arr) throw new Error("格式不对，应该是一个数组");
      for (const item of arr) {
        const e = parseEntry(item);
        if (e) entries.push(e);
        else console.warn("[dongni] 衣橱清单里有一条没用上（key 不合法，或者是新加的那件缺少 name / wear）");
      }
    } catch (e) {
      console.warn(`[dongni] 衣橱清单读不了，先用内置那几套：${e instanceof Error ? e.message : e}`);
    }
  }
  const list = merge(entries);
  if (cache) version += 1;
  cache = { file, exists, text, list };
  if (!first) console.log(`[dongni] 衣橱清单更新了：${list.length} 套（${list.map((o) => o.name).join("、")}）`);
  return list;
}

export type WearContext = { hour: number; temp?: number; kind?: WeatherKind; month: number };

function inRange(range: [number, number], v: number) {
  const [a, b] = range;
  return a <= b ? v >= a && v < b : v >= a || v < b;
}

function hits(rule: OutfitRule, ctx: WearContext) {
  if (rule.hours && !inRange(rule.hours, ctx.hour)) return false;
  if (rule.months && !inRange(rule.months, ctx.month)) return false;
  if (rule.tempMin !== undefined || rule.tempMax !== undefined) {
    // 温度不知道就不猜：带温度条件的造型没温度时不算命中
    if (ctx.temp === undefined) return false;
    if (rule.tempMin !== undefined && ctx.temp < rule.tempMin) return false;
    if (rule.tempMax !== undefined && ctx.temp > rule.tempMax) return false;
  }
  if (rule.kinds && (!ctx.kind || !rule.kinds.includes(ctx.kind))) return false;
  return true;
}

/** 带条件的造型里挑一个穿：priority 大的先，同样大的后加的优先 */
export function pickByRule(ctx: WearContext): Outfit | null {
  let best: Outfit | null = null;
  let bestPri = -Infinity;
  for (const o of outfits()) {
    if (!o.rule || !hits(o.rule, ctx)) continue;
    const pri = o.rule.priority ?? 0;
    if (pri >= bestPri) {
      best = o;
      bestPri = pri;
    }
  }
  return best;
}