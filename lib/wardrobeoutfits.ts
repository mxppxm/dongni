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
 *     "pose": "英文的招牌动作", "poses": ["英文动作1", "英文动作2", "英文动作3"],
 *     "real": true,
 *     "rule": { "hours": [8, 18], "tempMax": 2, "kinds": ["snow"], "months": [11, 3], "priority": 5 } }
 * key 只用字母数字下划线横线（它同时是定妆照的文件名），name、wear 新加的那件必填。
 * pose / poses 可选：定妆照用第一句，拍今天的照片按这张数轮换；不写就按名字和衣服猜一组。
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
  /**
   * 这身的动作姿势，英文，第一句是定妆照那个招牌动作，后面几句是重拍时轮换的。
   * 清单文件里也可以只写一个 pose（等于只有一句）。
   */
  poses?: string[];
};

/**
 * 每身衣服的动作，互不重复，贴着那身的气质走。
 * 定妆照用第一句；「拍今天的照片」按这套衣服拍过的张数往下轮，同一身反复拍也不会是同一个画面。
 */
const POSE_SETS = {
  sunny: [
    "walking towards the camera with a light bounce, one hand pulling the hoodie hem down, the other swinging free",
    "sitting sideways on a low stone wall, legs swinging, face lifted towards the sun",
    "spinning mid-step with both arms out, hair and hoodie strings flying",
  ],
  rainy: [
    "walking under a clear umbrella tilted back over her shoulder, looking up at the falling rain",
    "stepping over a puddle on tiptoe, the umbrella held out to one side for balance",
    "pausing on the pavement with the umbrella resting on her shoulder, one hand held out to catch raindrops",
  ],
  cold: [
    "walking while lifting the hem of her long coat with one hand, the scarf's ends floating in the wind",
    "standing on a windy corner with both hands pushed into her coat pockets, shoulders tucked up, laughing",
    "turning back over her shoulder mid-stride, one hand holding her beanie down against the wind",
  ],
  run: [
    "mid-stride running towards the camera, arms pumping, ponytail swinging",
    "leaning forward to stretch one calf against a park bench, both hands on the bench",
    "jogging away and glancing back over her shoulder, one hand adjusting her cap",
  ],
  home: [
    "half-lying in bed propped on one elbow, the other hand lifting the duvet aside, sleepy smile",
    "sitting cross-legged on the rumpled bed, pillow hugged to her chest, eyes still half closed",
    "kneeling on the bed and leaning over to pull the curtain open, the cardigan slipping off one shoulder",
  ],
  indoor: [
    "sitting sideways on a wide windowsill with her knees drawn up, cheek resting on one knee, looking out",
    "sitting on the floor with her back against the sofa, legs stretched out, both hands around a warm mug",
    "standing in the window frame with one knee bent and her shoulder against the frame, holding a mug with both hands",
  ],
  leaf: [
    "kicking up a pile of fallen leaves with one foot, arms out for balance, laughing",
    "crouching down to pick up a bright fallen leaf, her scarf hanging forward",
    "walking through the leaves with both hands in her puffer pockets, looking down at her feet",
  ],
  evening: [
    "leaning back against a warm brick wall with one shoulder, ankles crossed, looking straight at the camera",
    "walking slowly along a lamplit street, one hand holding her cardigan closed at the chest",
    "stopping mid-step and turning to look back over her shoulder, hands relaxed at her sides",
  ],
  library: [
    "standing on tiptoe to reach a book on a high shelf, the open trench coat hanging down",
    "sitting on a low bench between tall shelves with a book open on her knees, head bent",
    "walking along a shelf and trailing one hand over the book spines, glancing back",
  ],
} as const;

/** 几套固定造型（衣服定死，每次都穿得一模一样） */
export const BUILTIN_OUTFITS: Outfit[] = [
  { key: "sunny", name: "晴天亮色", when: "晴天、多云，不冷不热的白天", wear: "a mint-green oversized hoodie, light denim shorts, white sneakers with mint laces", poses: [...POSE_SETS.sunny] },
  { key: "rainy", name: "雨天灰调", when: "下雨、下雪、阴沉的天", wear: "a soft grey hooded raincoat over a cream knit sweater, dark grey jeans, glossy black rain boots, holding a clear umbrella", poses: [...POSE_SETS.rainy] },
  { key: "cold", name: "冷天外套", when: "气温低于 12°C", wear: "a camel wool duffle coat, a chunky cream scarf, a brown knit beanie, dark jeans, brown lace-up ankle boots", poses: [...POSE_SETS.cold] },
  { key: "run", name: "跑步那身", when: "清晨 6–8 点，天不下雨", wear: "an orange zip running jacket, black running leggings, a white cap, neon running shoes, a sports watch", poses: [...POSE_SETS.run] },
  { key: "home", name: "夜里窝着", when: "晚上 10 点以后到早上 7 点", wear: "a loose oatmeal cardigan over lavender pajamas with tiny star prints, fluffy white slippers", poses: [...POSE_SETS.home] },
  { key: "indoor", name: "窝着的下午", when: "白天 10°C 以下的室内日子", wear: "杏色粗针织开衫配白圆领T，深棕格纹A字裙，厚羊毛连裤袜，米白软底家居拖鞋", real: true, poses: [...POSE_SETS.indoor] },
  { key: "leaf", name: "出门踩叶子", when: "冷天出门 3–8°C 晴或多云", wear: "奶白短羽绒服、灰蓝连帽卫衣、直筒牛仔裤、燕麦色粗针织围巾、白色帆布鞋", real: true, poses: [...POSE_SETS.leaf] },
  { key: "evening", name: "晚上有点讲究", when: "18 点以后出门", wear: "墨绿丝绒连衣裙、黑色薄开衫、细金项链、黑色短靴", real: true, poses: [...POSE_SETS.evening] },
  {
    key: "library",
    name: "阴天的图书馆",
    when: "秋季阴天、5~12°C 的白天到傍晚",
    wear: "深灰色高领薄毛衣，外搭卡其色长风衣（敞开穿），深蓝色直筒牛仔裤，棕色短靴",
    real: true,
    poses: [...POSE_SETS.library],
    rule: { hours: [8, 19], tempMin: 5, tempMax: 12, kinds: ["cloud"], months: [9, 12], priority: 5 },
  },
];

/**
 * 清单文件里新加的、没写动作的那身：按名字和衣服猜一组气质相近的动作。
 * 这些是另写的，不和上面内置那几身撞；实在猜不到就按 key 固定挑一组通用的，至少每次重拍有变化。
 */
const POSE_HINTS: { test: RegExp; poses: string[] }[] = [
  {
    test: /睡衣|睡裙|睡裤|睡前|被子|床上|pajama|nightgown|sleep|duvet|bed/i,
    poses: [
      "lying on her side in bed, one arm under the pillow, the duvet pulled up to her shoulder",
      "sitting on the edge of the bed, both hands pushing her messy hair back",
      "curled up on the bed with her knees tucked, face half buried in the pillow",
    ],
  },
  {
    test: /开衫|毛衣|针织|家居|沙发|窝|cardigan|knit|sweater|lounge|sofa|cozy/i,
    poses: [
      "curled up in the corner of a sofa with her knees hugged to her chest, chin resting on her knees",
      "lying along the sofa on her stomach, propped up on her elbows, ankles crossed in the air",
      "sitting cross-legged in the middle of the sofa with a cushion on her lap, sleeves pulled over her hands",
    ],
  },
  {
    test: /雨|伞|rain|umbrella/i,
    poses: [
      "shaking out a wet umbrella to one side, droplets flying",
      "walking with the umbrella held low over her head, shoulders hunched",
      "standing under an awning with the folded umbrella in both hands, watching the rain",
    ],
  },
  {
    test: /运动|跑步|健身|瑜伽|legging|sport|run|jog/i,
    poses: [
      "stretching both arms overhead after a run, one hip cocked",
      "jogging in place at a crossing, looking both ways",
      "bending down to tie a shoelace, one knee lowered",
    ],
  },
  {
    test: /裙|礼服|丝绒|dress|velvet|gown/i,
    poses: [
      "sitting on a low step in her dress, one hand resting on the step beside her",
      "walking away from the camera and glancing back over her shoulder, the dress moving with her step",
      "leaning one hand on a railing, body turned three-quarters, looking off to the side",
    ],
  },
  {
    test: /风衣|外套|大衣|羽绒|coat|trench|puffer|jacket/i,
    poses: [
      "walking with both hands pushed into her coat pockets, the open coat swaying as she steps",
      "standing with her collar turned up against the wind, one shoulder lifted, looking past the camera",
      "sitting on a low wall in her coat, hands tucked between her knees",
    ],
  },
];

const GENERIC_POSE_SETS: string[][] = [
  [
    "walking a few steps towards the camera, one hand in a pocket, the other brushing her hair back",
    "sitting on a low ledge at an angle, forearms on her knees, chin lifted towards the camera",
    "turning halfway back over her shoulder, caught mid-step, one hand holding her sleeve",
  ],
  [
    "standing relaxed but off-centre, weight on one leg, hands loosely clasped in front of her",
    "walking past the camera and looking back with a small smile, arms relaxed",
    "crouching down to look at something on the ground, one elbow resting on her knee",
  ],
  [
    "sitting on the ground with her legs folded to one side, one hand propping her up",
    "leaning her shoulder against a doorway, one ankle crossed over the other, arms folded",
    "walking away while stretching one arm out to the side, head turned towards the camera",
  ],
];

const hashKey = (key: string) => [...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);

/** 这身的动作组：清单里写了就用写的，没写就猜；只有一句时补两句通用的，保证重拍时有得换 */
export function outfitPoses(o: Outfit): string[] {
  let own = o.poses ?? [];
  if (!own.length) {
    const text = `${o.name} ${o.wear}`;
    own = POSE_HINTS.find((h) => h.test.test(text))?.poses ?? GENERIC_POSE_SETS[hashKey(o.key) % GENERIC_POSE_SETS.length];
  }
  if (own.length >= 3) return own;
  const extra = GENERIC_POSE_SETS[hashKey(o.key) % GENERIC_POSE_SETS.length].filter((p) => !own.includes(p));
  return [...own, ...extra].slice(0, 3);
}

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
  const poses = Array.isArray(o.poses)
    ? o.poses
        .filter((p): p is string => typeof p === "string" && !!p.trim())
        .map((p) => p.trim().slice(0, 400))
        .slice(0, 6)
    : [];
  const pose = str(o.pose, 400);
  if (poses.length) out.poses = poses;
  else if (pose) out.poses = [pose];
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
      list.push({ key: e.key!, name: e.name, when: e.when ?? "", wear: e.wear, real: e.real, poses: e.poses, rule: e.rule });
    } else {
      const old = list[i];
      list[i] = { ...old, ...e, key: old.key, name: e.name ?? old.name, when: e.when ?? old.when, wear: e.wear ?? old.wear };
    }
  }
  return list;
}

/**
 * 往清单文件里加一件（同 key 就是改那一件）。写的是 data/wardrobe/outfits.json，不动代码，下一次读衣橱就生效。
 * 返回写进去的那一条；内容不合规范就抛错，说清楚缺什么。
 */
export function saveOutfit(raw: Record<string, unknown>): Outfit {
  const name = str(raw.name, 40);
  if (!name) throw new Error("得给这身起个名字（name）");
  const key = str(raw.key, 32) ?? `o${Date.now().toString(36)}`;
  if (!KEY.test(key)) throw new Error("key 只能用字母、数字、下划线、横线");
  const entry = parseEntry({ ...raw, key, name });
  const builtin = BUILTIN_OUTFITS.some((o) => o.key === key);
  if (!entry || (!builtin && !entry.wear)) throw new Error("得写清楚这身穿什么（wear）");
  const file = OUTFITS_FILE();
  let list: unknown[] = [];
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    list = Array.isArray(old) ? old : Array.isArray((old as { outfits?: unknown[] })?.outfits) ? (old as { outfits: unknown[] }).outfits : [];
  } catch {
    /* 文件还没有：从空清单开始 */
  }
  const next = [...list.filter((o) => (o as { key?: string })?.key !== key), entry];
  fs.mkdirSync(WARDROBE_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return outfits().find((o) => o.key === key)!;
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