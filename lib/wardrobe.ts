import "server-only";
import { gptimgScript } from "./portable";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, getKv, setKv } from "./db";
import { completeJson } from "./llm";
import { nowText } from "./memory";
import { INTRO, PERSONA } from "./persona";
import { track } from "./tasks";

/**
 * 衣橱和相册。
 * 衣橱：几套固定造型，每套一张定妆照（3D 写实、全身、能看到鞋）。穿哪套由「时间 × 季节 × 天气」按规则算，不随机。
 * 相册：按日期往下攒，照片文件名带日期；同一天再拍就追加一张，以前的日子一律不覆盖、不删。
 * 每张照片配日期、天气、她写的一句话。拍之前先在对话里说一声。
 */
const run = promisify(execFile);
const ROOT = process.cwd();
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(ROOT, "data");
const DIR = path.join(DATA_DIR, "wardrobe");
const GPTIMG = gptimgScript();
const CHIBI = path.join(ROOT, "public", "mood", "anchor.png");
const ANCHOR3D = path.join(DIR, "anchor3d.png");

const LOOK =
  "a cheerful 20-year-old East Asian girl with a high messy brown ponytail tied with an orange scrunchie, short wispy bangs, big bright eyes, rosy cheeks";
const STYLE =
  "Stylized realistic 3D character render, like a modern animated feature film, soft global illumination, high detail, full body from head to shoes clearly visible, no text, no watermark";

export type Outfit = { key: string; name: string; when: string; wear: string };

/** 几套固定造型（衣服定死，每次都穿得一模一样） */
export const OUTFITS: Outfit[] = [
  { key: "sunny", name: "晴天亮色", when: "晴天、多云，不冷不热的白天", wear: "a mint-green oversized hoodie, light denim shorts, white sneakers with mint laces" },
  { key: "rainy", name: "雨天灰调", when: "下雨、下雪、阴沉的天", wear: "a soft grey hooded raincoat over a cream knit sweater, dark grey jeans, glossy black rain boots, holding a clear umbrella" },
  { key: "cold", name: "冷天外套", when: "气温低于 12°C", wear: "a camel wool duffle coat, a chunky cream scarf, a brown knit beanie, dark jeans, brown lace-up ankle boots" },
  { key: "run", name: "跑步那身", when: "清晨 6–8 点，天不下雨", wear: "an orange zip running jacket, black running leggings, a white cap, neon running shoes, a sports watch" },
  { key: "home", name: "夜里窝着", when: "晚上 10 点以后到早上 7 点", wear: "a loose oatmeal cardigan over lavender pajamas with tiny star prints, fluffy white slippers" },
];

/* ---------------- 天气 ---------------- */

/**
 * 实时天气：open-meteo（免费、不用 key）。城市默认北京，set_city 记过就用记下的那个。
 * 拿不到就返回 null——不猜、不编，调用方要照实说「没取到实时天气」。
 */
export type Weather = {
  city: string;
  temp: number;
  /** 体感温度（°C） */
  feels?: number;
  text: string;
  kind: "sun" | "cloud" | "rain" | "snow" | "unknown";
  humidity?: number;
  /** 风速 km/h */
  wind?: number;
  /** 风向，比如「东北风」 */
  windDir?: string;
  /** 风力等级 0–12 */
  windLevel?: number;
  /** 今天最高 / 最低温 */
  high?: number;
  low?: number;
  /** 今晚（今天剩下的时间）最低温；过了今晚就是明天凌晨 */
  tonightLow?: number;
  /** 再过几小时的温度，用来判断在升温还是降温 */
  nextTemp?: number;
  trend?: "up" | "down" | "flat";
  advice: string;
  /** 接口没连上、退回最近一次成功的数据时，这里是那次抓到的时刻 */
  staleAt?: number;
};

/** 风向角度 → 中文风向 */
function windDirName(deg: number) {
  const dirs = ["北风", "东北风", "东风", "东南风", "南风", "西南风", "西风", "西北风"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** 风速 km/h → 蒲福风力等级，说话时用「几级风」比数字直观 */
function beaufort(kmh: number) {
  const steps = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  let level = 0;
  for (const s of steps) if (kmh >= s) level++;
  return level;
}

export const HOME_CITY = "北京";

/** 常去的城市先查表，省一次地理编码；表里没有的交给 open-meteo 的地理编码（结果写进 kv，只查一次） */
const KNOWN_CITIES: Record<string, [number, number]> = {
  北京: [39.9042, 116.4074],
  上海: [31.2304, 121.4737],
  广州: [23.1291, 113.2644],
  深圳: [22.5431, 114.0579],
  杭州: [30.2741, 120.1551],
  南京: [32.0603, 118.7969],
  成都: [30.5728, 104.0668],
  重庆: [29.563, 106.5516],
  武汉: [30.5928, 114.3055],
  西安: [34.3416, 108.9398],
  天津: [39.3434, 117.3616],
  苏州: [31.2989, 120.5853],
  长沙: [28.2282, 112.9388],
  郑州: [34.7466, 113.6254],
  青岛: [36.0671, 120.3826],
  厦门: [24.4798, 118.0894],
  沈阳: [41.8057, 123.4315],
  哈尔滨: [45.8038, 126.5349],
  昆明: [25.0389, 102.7183],
  大连: [38.914, 121.6147],
  香港: [22.3193, 114.1694],
  台北: [25.033, 121.5654],
};

/** WMO weather code → 中文说法 + 大类（wttr 那套代码跟这个不一样，别再混用） */
const WEATHER_CODE: Record<number, [string, Weather["kind"]]> = {
  0: ["晴", "sun"],
  1: ["晴间多云", "sun"],
  2: ["多云", "cloud"],
  3: ["阴", "cloud"],
  45: ["有雾", "cloud"],
  48: ["雾凇", "cloud"],
  51: ["毛毛雨", "rain"],
  53: ["毛毛雨", "rain"],
  55: ["细雨", "rain"],
  56: ["冻雨", "rain"],
  57: ["冻雨", "rain"],
  61: ["小雨", "rain"],
  63: ["中雨", "rain"],
  65: ["大雨", "rain"],
  66: ["冻雨", "rain"],
  67: ["冻雨", "rain"],
  71: ["小雪", "snow"],
  73: ["中雪", "snow"],
  75: ["大雪", "snow"],
  77: ["雪粒", "snow"],
  80: ["阵雨", "rain"],
  81: ["阵雨", "rain"],
  82: ["暴雨", "rain"],
  85: ["阵雪", "snow"],
  86: ["大阵雪", "snow"],
  95: ["雷阵雨", "rain"],
  96: ["雷阵雨伴冰雹", "rain"],
  99: ["雷阵雨伴冰雹", "rain"],
};

function describe(code: number): { text: string; kind: Weather["kind"] } {
  const hit = WEATHER_CODE[code];
  if (hit) return { text: hit[0], kind: hit[1] };
  if (code >= 95) return { text: "雷阵雨", kind: "rain" };
  if (code >= 80) return { text: "阵雨", kind: "rain" };
  if (code >= 71) return { text: "下雪", kind: "snow" };
  if (code >= 61) return { text: "下雨", kind: "rain" };
  if (code >= 51) return { text: "毛毛雨", kind: "rain" };
  if (code >= 45) return { text: "有雾", kind: "cloud" };
  if (code >= 3) return { text: "阴", kind: "cloud" };
  if (code >= 1) return { text: "多云", kind: "cloud" };
  return { text: "天气不明", kind: "unknown" };
}

/** 温度（体感优先）+ 天气 + 风 → 一句穿搭建议（跟衣橱的选法对得上） */
function adviceFor(temp: number, kind: Weather["kind"], wind: number, opts: { feels?: number; trend?: Weather["trend"]; nextTemp?: number } = {}) {
  const out: string[] = [];
  if (temp >= 30) out.push("热，短袖短裤或裙子");
  else if (temp >= 24) out.push("暖和，短袖配条长裤");
  else if (temp >= 18) out.push("舒服，长袖或薄针织就够");
  else if (temp >= 12) out.push("有点凉，外面加件外套");
  else if (temp >= 5) out.push("冷，厚外套或薄羽绒");
  else out.push("很冷，羽绒服、围巾手套都上身");
  // 体感差得多就提一句：同样 16 度，风一吹就不一样
  const feels = opts.feels;
  if (feels !== undefined && Math.abs(feels - temp) >= 3) out.push(feels < temp ? `体感只有 ${feels}°C，穿厚一点` : `体感有 ${feels}°C，别穿太多`);
  if (kind === "rain") out.push("带伞，鞋挑防水的");
  else if (kind === "snow") out.push("鞋要防滑保暖，路滑走慢点");
  else if (kind === "sun" && temp >= 28) out.push("记得防晒");
  if (wind >= 25) out.push("风大，加件防风的");
  else if (wind >= 12) out.push("有点风，外套挑防风的");
  if (opts.trend === "down" && opts.nextTemp !== undefined && temp - opts.nextTemp >= 4) out.push(`过几小时降到 ${opts.nextTemp}°C，带件薄的`);
  return out.join("，");
}

/** 成功的结果留 10 分钟（跟 15 分钟一次的日常检查配合）；旧数据只留 2 分钟，好尽快再试新的；失败留 90 秒，别一直卡着 */
const OK_TTL = 10 * 60_000;
const FAIL_TTL = 90_000;
const STALE_TTL = 2 * 60_000;
/** 宁可快点超时再试，也别一次挂在那儿等 8 秒 */
const FORECAST_TIMEOUT = 3_500;
const GEO_TIMEOUT = 3_000;
/** 一次 + 重试两次 */
const FORECAST_TRIES = 3;
const RETRY_GAP = 300;

let weatherCache: { at: number; city: string; w: Weather | null } | null = null;
/** 同时有好几个人要天气（提示词、相册、拍照）只发一次请求，别各查各的 */
let inFlight: { city: string; p: Promise<Weather | null> } | null = null;
/** 最近一次真的抓到的天气：内存一份、kv 一份，重启后也能拿来兜底 */
let lastGood: { at: number; city: string; w: Weather } | null = null;
const geoCache = new Map<string, { name: string; lat: number; lon: number }>();

const hhmm = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

function rememberGood(city: string, w: Weather) {
  const at = Date.now();
  lastGood = { at, city, w };
  try {
    setKv(`weather_last:${city}`, JSON.stringify({ at, w }));
  } catch {
    /* kv 写不进就只留内存这份 */
  }
}

function lastGoodFor(city: string): { at: number; w: Weather } | null {
  if (lastGood && lastGood.city === city) return { at: lastGood.at, w: lastGood.w };
  try {
    const saved = getKv(`weather_last:${city}`);
    if (!saved) return null;
    const j = JSON.parse(saved) as { at?: unknown; w?: Weather };
    if (j.w && typeof j.w === "object" && Number.isFinite(j.at) && Number.isFinite(j.w.temp)) {
      const hit = { at: j.at as number, w: j.w };
      lastGood = { at: hit.at, city, w: hit.w };
      return hit;
    }
  } catch {
    /* 存坏了就当没有 */
  }
  return null;
}

/** 上次成功抓到的天气，标上抓取时刻，调用方一看就知道是几点的旧数据 */
function staleCopy(city: string): Weather | null {
  const old = lastGoodFor(city);
  return old ? { ...old.w, staleAt: old.at } : null;
}

/** 失败原因说人话：是超时，还是接口回了别的东西 */
function why(e: unknown) {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `超时（${FORECAST_TIMEOUT / 1000} 秒没回话）`;
  const code = err?.cause?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析失败";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") return `连不上（${code}）`;
  return err?.message || String(e);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function getCity() {
  return (getKv("weather_city") ?? "").trim() || HOME_CITY;
}

export function setCity(city: string) {
  setKv("weather_city", city.trim());
  weatherCache = null;
}

async function coordsFor(city: string) {
  const known = KNOWN_CITIES[city];
  if (known) return { name: city, lat: known[0], lon: known[1] };
  const mem = geoCache.get(city);
  if (mem) return mem;
  const saved = getKv(`weather_geo:${city}`);
  if (saved) {
    try {
      const c = JSON.parse(saved) as { name: string; lat: number; lon: number };
      if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
        geoCache.set(city, c);
        return c;
      }
    } catch {
      /* 存坏了就当没存，重新查 */
    }
  }
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(GEO_TIMEOUT), cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { results?: { name?: string; latitude?: number; longitude?: number }[] };
    const r = j.results?.[0];
    if (!r || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) return null;
    const c = { name: r.name || city, lat: r.latitude as number, lon: r.longitude as number };
    geoCache.set(city, c);
    setKv(`weather_geo:${city}`, JSON.stringify(c));
    return c;
  } catch {
    return null;
  }
}

async function fetchWeather(city: string): Promise<{ w?: Weather; reason?: string }> {
  const c = await coordsFor(city);
  if (!c) return { reason: "城市坐标没查到" };
  let reason = "没发出请求";
  for (let i = 0; i < FORECAST_TRIES; i++) {
    if (i > 0) await sleep(RETRY_GAP * i);
    const out = await forecastOnce(city, c);
    if (out.w) return out;
    reason = out.reason ?? "原因不明";
  }
  return { reason: `${reason}（试了 ${FORECAST_TRIES} 次）` };
}

async function forecastOnce(city: string, c: { lat: number; lon: number }): Promise<{ w?: Weather; reason?: string }> {
  try {
    const url =
      "https://api.open-meteo.com/v1/forecast?" +
      `latitude=${c.lat}&longitude=${c.lon}` +
      "&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,wind_direction_10m" +
      "&daily=temperature_2m_max,temperature_2m_min" +
      "&hourly=temperature_2m&forecast_days=2&timezone=auto";
    const res = await fetch(url, { signal: AbortSignal.timeout(FORECAST_TIMEOUT), cache: "no-store" });
    if (!res.ok) return { reason: `接口返回 ${res.status}` };
    const j = (await res.json()) as {
      current?: {
        time?: string;
        temperature_2m?: unknown;
        apparent_temperature?: unknown;
        weather_code?: unknown;
        relative_humidity_2m?: unknown;
        wind_speed_10m?: unknown;
        wind_direction_10m?: unknown;
      };
      daily?: { temperature_2m_max?: unknown[]; temperature_2m_min?: unknown[] };
      hourly?: { time?: string[]; temperature_2m?: unknown[] };
    };
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const temp = num(j.current?.temperature_2m);
    const code = num(j.current?.weather_code);
    if (temp === undefined || code === undefined) return { reason: "返回里没有温度或天气代码" };
    const feels = num(j.current?.apparent_temperature);
    const humidity = num(j.current?.relative_humidity_2m);
    const wind = num(j.current?.wind_speed_10m);
    const windDeg = num(j.current?.wind_direction_10m);
    const high = num(j.daily?.temperature_2m_max?.[0]);
    const low = num(j.daily?.temperature_2m_min?.[0]);

    // 逐小时温度：从现在往后看 6 小时判趋势，再看今天剩下的时间里的最低温（今晚会降到几度）
    const times = j.hourly?.time ?? [];
    const temps = (j.hourly?.temperature_2m ?? []).map((v) => num(v));
    const nowIso = String(j.current?.time ?? "");
    const hourKey = nowIso.slice(0, 13);
    let idx = times.findIndex((t) => t.slice(0, 13) === hourKey);
    if (idx < 0) idx = times.findIndex((t) => t >= nowIso);
    let nextTemp: number | undefined;
    let tonightLow: number | undefined;
    if (idx >= 0) {
      nextTemp = temps[idx + 6];
      const today = times[idx].slice(0, 10);
      for (let i = idx; i < times.length; i++) {
        if (!times[i].startsWith(today)) break;
        const t = temps[i];
        if (t !== undefined && (tonightLow === undefined || t < tonightLow)) tonightLow = t;
      }
    }
    const { text, kind } = describe(code);
    const trend: Weather["trend"] | undefined =
      nextTemp === undefined ? undefined : nextTemp - temp <= -1 ? "down" : nextTemp - temp >= 1 ? "up" : "flat";
    const windRounded = wind === undefined ? undefined : Math.round(wind);
    const w: Weather = {
      city,
      temp: Math.round(temp),
      feels: feels === undefined ? undefined : Math.round(feels),
      text,
      kind,
      humidity: humidity === undefined ? undefined : Math.round(humidity),
      wind: windRounded,
      windDir: windDeg === undefined ? undefined : windDirName(windDeg),
      windLevel: windRounded === undefined ? undefined : beaufort(windRounded),
      high: high === undefined ? undefined : Math.round(high),
      low: low === undefined ? undefined : Math.round(low),
      tonightLow: tonightLow === undefined ? undefined : Math.round(tonightLow),
      nextTemp: nextTemp === undefined ? undefined : Math.round(nextTemp),
      trend,
      advice: adviceFor(temp, kind, wind ?? 0, {
        feels: feels === undefined ? undefined : Math.round(feels),
        trend,
        nextTemp: nextTemp === undefined ? undefined : Math.round(nextTemp),
      }),
    };
    return { w };
  } catch (e) {
    return { reason: why(e) };
  }
}

export async function getWeather(): Promise<Weather | null> {
  const city = getCity();
  if (weatherCache && weatherCache.city === city) {
    const c = weatherCache.w;
    const ttl = !c ? FAIL_TTL : c.staleAt ? STALE_TTL : OK_TTL;
    if (Date.now() - weatherCache.at < ttl) return weatherCache.w;
  }
  if (inFlight && inFlight.city === city) return inFlight.p;
  const entry: { city: string; p: Promise<Weather | null> } = { city, p: Promise.resolve(null) };
  entry.p = fetchWeather(city)
    .catch((e) => ({ reason: why(e) }) as { w?: Weather; reason?: string })
    .then((out) => {
      if (out.w) {
        rememberGood(city, out.w);
        weatherCache = { at: Date.now(), city, w: out.w };
        return out.w;
      }
      const old = staleCopy(city);
      weatherCache = { at: Date.now(), city, w: old };
      // 一行日志：是超时还是返回异常，一看就清楚
      console.warn(`[dongni] ${city} 的实时天气没取到：${out.reason ?? "原因不明"}${old ? `；先用 ${hhmm(old.staleAt!)} 的旧数据顶上` : "；也没有能用的旧数据"}`);
      return old;
    });
  inFlight = entry;
  return entry.p;
}

const season = (m = new Date().getMonth() + 1) => (m >= 3 && m <= 5 ? "春" : m >= 6 && m <= 8 ? "夏" : m >= 9 && m <= 11 ? "秋" : "冬");

/** 规则写死：同样的时间、天气，穿出来一定是同一身 */
export function pickOutfit(w: Weather | null, d = new Date()): Outfit {
  const h = d.getHours();
  const byKey = (k: string) => OUTFITS.find((o) => o.key === k)!;
  const wet = w?.kind === "rain" || w?.kind === "snow";
  if (h >= 22 || h < 6) return byKey("home");
  if (h < 8 && !wet) return byKey("run");
  if (h < 7) return byKey("home");
  if (wet) return byKey("rainy");
  const cold = w ? (w.feels ?? w.temp) < 12 : season() === "冬";
  if (cold) return byKey("cold");
  return byKey("sunny");
}

export async function today() {
  const w = await getWeather();
  const outfit = pickOutfit(w);
  return { weather: w, outfit, season: season() };
}

/** 提示词里等不起太久：一点点没回来就先拿上次成功的数据顶上，请求本身还在后台跑，下次就有新的 */
function weatherSoon(ms: number) {
  return new Promise<Weather | null>((ok) => {
    const timer = setTimeout(() => ok(staleCopy(getCity())), ms);
    getWeather().then(
      (w) => {
        clearTimeout(timer);
        ok(w);
      },
      () => {
        clearTimeout(timer);
        ok(null);
      },
    );
  });
}

/** 把天气说成一句人话：体感、湿度、风、今天高低、晚上降多少都在里面 */
export function weatherText(w: Weather) {
  const bits = [w.staleAt ? `${w.city}${hhmm(w.staleAt)}那会儿${w.text}，${w.temp}°C` : `${w.city}现在${w.text}，${w.temp}°C`];
  if (w.feels !== undefined && w.feels !== w.temp) bits.push(`体感 ${w.feels}°C`);
  if (w.humidity !== undefined) bits.push(`湿度 ${w.humidity}%`);
  if (w.windDir !== undefined) bits.push(`${w.windDir}${w.windLevel !== undefined ? ` ${w.windLevel} 级` : ""}${w.wind !== undefined ? `（${w.wind}km/h）` : ""}`);
  if (w.low !== undefined && w.high !== undefined) bits.push(`今天 ${w.low}~${w.high}°C`);
  if (w.tonightLow !== undefined && w.tonightLow <= w.temp - 3) bits.push(`今晚降到 ${w.tonightLow}°C`);
  if (w.trend === "down" && w.nextTemp !== undefined) bits.push(`接下来几小时降到 ${w.nextTemp}°C`);
  else if (w.trend === "up" && w.nextTemp !== undefined) bits.push(`接下来几小时升到 ${w.nextTemp}°C`);
  else if (w.trend === "flat" && w.nextTemp !== undefined) bits.push(`接下来几小时 ${w.nextTemp}°C 左右`);
  if (w.staleAt) bits.push(`这是 ${hhmm(w.staleAt)} 的旧数据（接口这会儿没连上）`);
  return bits.join("，");
}

/** 写进她的系统提示词：她知道自己今天穿什么、外面什么天。没取到就明说，不许编。 */
export async function wardrobeNote() {
  const w = await weatherSoon(1200);
  const outfit = pickOutfit(w);
  const city = getCity();
  const sky = w
    ? `${weatherText(w)}${w.advice ? `，${w.advice}` : ""}`
    : `${city}的实时天气没取到（接口没响应或超时），别猜天气、别编天气`;
  return `你今天穿的是「${outfit.name}」那身。现在是${season()}天，${sky}。`;
}

/* ---------------- 画图 ---------------- */

async function draw(prompt: string, refs: string[], out: string, size = "1024x1536") {
  const args = [GPTIMG, prompt, "-o", out, "--size", size, "--quality", "high", "--json"];
  for (const r of refs) args.push("--ref", r);
  await run(process.execPath, args, { timeout: 10 * 60_000, maxBuffer: 20 << 20 });
  await run("/usr/bin/sips", ["-Z", "1400", "-s", "format", "jpeg", out, "--out", out.replace(/\.png$/, ".jpg")]);
  fs.rmSync(out, { force: true });
}

const g = globalThis as unknown as { __dongniWardrobeBusy?: boolean; __dongniAlbumReady?: boolean };

/** 衣橱：定妆照缺哪套补哪套（一次性，之后都复用） */
export async function ensureWardrobe() {
  if (g.__dongniWardrobeBusy) return;
  g.__dongniWardrobeBusy = true;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(ANCHOR3D.replace(/\.png$/, ".jpg"))) {
      const ref = path.join(os.tmpdir(), "dongni-chibi-1024.png");
      await run("/usr/bin/sips", ["-Z", "1024", CHIBI, "--out", ref]);
      await draw(
        `Turn the reference chibi sticker into the same character as a ${STYLE}: ${LOOK}, wearing a mint-green oversized hoodie, light denim shorts and white sneakers, standing relaxed and smiling, plain soft light-grey studio background.`,
        [ref],
        ANCHOR3D,
      );
    }
    for (const o of OUTFITS) {
      const file = path.join(DIR, `${o.key}.png`);
      if (fs.existsSync(file.replace(/\.png$/, ".jpg"))) continue;
      await track(
        "wardrobe",
        `做定妆照「${o.name}」`,
        () =>
          draw(
            `Same girl as the reference (same face, hair, scrunchie, proportions, same rendering style). ${STYLE}. Fashion lookbook shot, she is wearing ${o.wear}. Standing pose full of energy, plain soft light-grey studio background.`,
            [ANCHOR3D.replace(/\.png$/, ".jpg")],
            file,
          ),
        () => ({ ok: true, result: `![${o.name}](/api/wardrobe/${o.key}.jpg)` }),
      );
      console.log(`[dongni] 衣橱：做好「${o.name}」`);
    }
  } catch (e) {
    console.warn("[dongni] 衣橱定妆照失败：", e instanceof Error ? e.message : e);
  } finally {
    g.__dongniWardrobeBusy = false;
  }
}

export const wardrobeFile = (name: string) => {
  const f = path.join(DIR, path.basename(name));
  return fs.existsSync(f) ? f : null;
};

/* ---------------- 相册 ---------------- */

export type Photo = {
  id: number;
  date: string;
  outfit: string;
  weather: string;
  caption: string;
  file: string;
  created_at: number;
};

/** 照片文件名里带着日期：album-2026-10-29-<拍摄时间(base36)>.jpg */
const ALBUM_FILE = /^album-(\d{4}-\d{2}-\d{2})-(.+)\.(?:jpg|jpeg|png)$/i;

/**
 * 相册一张一行，同一天可以有好几张（再拍就追加），日期不做主键。
 * 老库里那张「一天一行」的 album 表不动它，只把内容搬过来，一张都不丢。
 */
function albumTable() {
  db().exec(`CREATE TABLE IF NOT EXISTS album_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    file TEXT NOT NULL,
    outfit TEXT NOT NULL DEFAULT '',
    weather TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_album_photos_file ON album_photos(file);
  CREATE INDEX IF NOT EXISTS idx_album_photos_date ON album_photos(date, created_at);`);
  if (g.__dongniAlbumReady) return;
  g.__dongniAlbumReady = true;
  try {
    migrateAlbum();
  } catch (e) {
    console.warn("[dongni] 相册整理失败：", e instanceof Error ? e.message : e);
  }
}

type AlbumInsert = (date: string, file: string, outfit: string, weather: string, caption: string, created: number) => void;

/** 老表 + 磁盘上还在的历史照片，一起并进新表（重复的跳过，不会读两次） */
function migrateAlbum() {
  const has = (file: string) => !!db().prepare("SELECT 1 FROM album_photos WHERE file = ?").get(file);
  const ins: AlbumInsert = (date, file, outfit, weather, caption, created) => {
    if (has(file)) return;
    db()
      .prepare("INSERT OR IGNORE INTO album_photos(date, file, outfit, weather, caption, created_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(date, file, outfit, weather, caption, created);
  };
  const oldTable = db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'album'").get();
  if (oldTable) {
    const rows = db().prepare("SELECT * FROM album").all() as Omit<Photo, "id">[];
    for (const r of rows) ins(r.date, r.file, r.outfit ?? "", r.weather ?? "", r.caption ?? "", r.created_at || Date.now());
  }
  collectOrphans(ins, has);
}

/** 以前被「同一天只留一行」顶掉、但文件还在磁盘上的照片：按文件名里的日期捡回来 */
function collectOrphans(ins: AlbumInsert, has: (file: string) => boolean) {
  let files: string[] = [];
  try {
    files = fs.readdirSync(DIR);
  } catch {
    return;
  }
  const meta = new Map<string, { outfit: string; weather: string }>();
  for (const r of db().prepare("SELECT date, outfit, weather FROM album_photos ORDER BY date DESC, created_at DESC").all() as Photo[]) {
    if (!meta.has(r.date)) meta.set(r.date, { outfit: r.outfit, weather: r.weather });
  }
  for (const file of files) {
    const m = ALBUM_FILE.exec(file);
    if (!m || has(file)) continue;
    const date = m[1];
    const stamp = Number.parseInt(m[2], 36);
    let created = stamp;
    if (!Number.isFinite(created) || created < 1_000_000_000_000 || created > Date.now() + 86400_000) {
      try {
        created = Math.round(fs.statSync(path.join(DIR, file)).mtimeMs);
      } catch {
        continue;
      }
    }
    const info = meta.get(date);
    ins(date, file, info?.outfit ?? "", info?.weather ?? "", "", created);
  }
}

/** 相册：日期倒序，同一天里新的在前 */
export function listPhotos(): Photo[] {
  albumTable();
  return db().prepare("SELECT * FROM album_photos ORDER BY date DESC, created_at DESC, id DESC").all() as Photo[];
}

const dayKey = (d = new Date()) => d.toLocaleDateString("sv-SE");

function post(content: string) {
  db()
    .prepare("INSERT INTO messages(role, content, status, extracted, created_at) VALUES('assistant', ?, 'done', 1, ?)")
    .run(content, Date.now());
}

/**
 * 拍失败的时候：同一句「照片没拍出来」只说一次，别自动一遍遍重试、一遍遍刷屏。
 * 只有换了个原因、真有了新情况，或者他自己问起，才再说。
 */
const PHOTO_FAIL_KEY = "photo_fail";
const PHOTO_TOLD_KEY = "photo_fail_told";
const PHOTO_RETRY_QUIET_MS = 30 * 60_000;
const PHOTO_TOLD_QUIET_MS = 6 * 60 * 60_000;
type PhotoFail = { at: number; why: string };

function readPhotoFail(key: string): PhotoFail | null {
  try {
    const raw = getKv(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as PhotoFail;
    return v && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}

function writePhotoFail(key: string, v: PhotoFail | null) {
  try {
    setKv(key, v ? JSON.stringify(v) : "");
  } catch {
    // 记不下不影响拍照
  }
}

/** 脚本的报错原话在 stderr 里，e.message 只有一行 Command failed */
function photoWhy(e: unknown) {
  const err = e as { stderr?: string; message?: string; killed?: boolean; signal?: string };
  if (err?.killed || err?.signal) return "画图超时了";
  const lines = String(err?.stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = (lines.pop() ?? err?.message ?? "").replace(/^gptimg:\s*/, "").replace(/\s+/g, " ").trim();
  return last.slice(0, 120) || "不知道什么原因";
}

/** 今天这张：先说一声 → 拍（穿当天那套）→ 入相册 → 拿给他看。
 * force=true 是他让拍的（今天已经有了也重拍）。
 */
const photoFlag = globalThis as unknown as { __dongniPhotoBusy?: boolean };

/** 今天照片的真实状态 */
export function photoState(): string {
  albumTable();
  if (photoFlag.__dongniPhotoBusy) return "正在拍今天的照片";
  return db().prepare("SELECT 1 FROM album_photos WHERE date = ?").get(dayKey()) ? "今天的照片已经拍好放进相册了" : "今天还没拍照片";
}

export async function takeDailyPhoto(force = false): Promise<string> {
  if (photoFlag.__dongniPhotoBusy) return "正在拍着呢，等这张出来。";
  photoFlag.__dongniPhotoBusy = true;
  try {
    return await takeDailyPhotoInner(force);
  } finally {
    photoFlag.__dongniPhotoBusy = false;
  }
}

async function takeDailyPhotoInner(force: boolean): Promise<string> {
  albumTable();
  const date = dayKey();
  if (!force && db().prepare("SELECT 1 FROM album_photos WHERE date = ?").get(date)) return "今天已经拍过了。";
  // 自动那张：刚试过没成，就先别接着重试；重试也不吭声，拍成了再给他看
  const lastFail = readPhotoFail(PHOTO_FAIL_KEY);
  if (!force && lastFail && Date.now() - lastFail.at < PHOTO_RETRY_QUIET_MS) return `刚试过没拍成（${lastFail.why}），等会儿再试。`;
  const quietRetry = !force && !!lastFail && Date.now() - lastFail.at < PHOTO_TOLD_QUIET_MS;
  if (g.__dongniWardrobeBusy) return "衣橱还在准备，等一会儿再拍。";
  const t = await today();
  const ref = path.join(DIR, `${t.outfit.key}.jpg`);
  if (!fs.existsSync(ref)) {
    void ensureWardrobe();
    return "衣橱的定妆照还没做好，正在做，做好了再拍。";
  }
  const weatherText = t.weather ? `${t.weather.city} ${t.weather.text} ${t.weather.temp}°C` : "实时天气没取到";

  const plan = await completeJson<{ before: string; scene: string; caption: string }>(
    [
      {
        role: "system",
        content: `${INTRO}\n\n${PERSONA}\n\n现在是 ${nowText()}，${weatherText}，你今天穿「${t.outfit.name}」。你要给自己拍今天的相册照片（一天一张，像日记）。
输出 JSON：
- before：拍之前跟他说的一句话（口语、短，让他知道你要拍了）
- scene：照片场景，英文，一句话：地点、在做什么、光线，要贴合今天的时间、季节、天气和这身衣服，全身入镜能看到鞋
- caption：相册里这张照片下面写的一句话，像日记，中文，二十字以内`,
      },
      { role: "user", content: "拍今天这张" },
    ],
    800,
    "low",
  );

  if (!quietRetry) post(plan.before || "今天的照片我去拍一张～");
  const file = `album-${date}-${Date.now().toString(36)}.png`;
  const jpg = file.replace(/\.png$/, ".jpg");
  try {
    await track(
      "take_photo",
      "拍今天的照片",
      () =>
        draw(
          `Same girl wearing exactly the same outfit as the reference image (same face, hair, scrunchie, clothes, shoes, same rendering style). ${STYLE}. ${plan.scene}`,
          [ref],
          path.join(DIR, file),
        ),
      () => ({ ok: true, result: `![今天](/api/wardrobe/${jpg})` }),
    );
  } catch (e) {
    const why = photoWhy(e);
    const now = Date.now();
    console.warn(`[dongni] 拍今天的照片没成：${why}`);
    writePhotoFail(PHOTO_FAIL_KEY, { at: now, why });
    const told = readPhotoFail(PHOTO_TOLD_KEY);
    const same = !!told && told.why === why && now - told.at < PHOTO_TOLD_QUIET_MS;
    // 他问了就解释；自动拍的同一个原因只说一次，重复的失败只写日志，不刷屏
    if (force || !same) {
      post(force && same ? `还是没拍成，原因没变：${why}` : `诶，照片没拍出来（${why}）。${force ? "我再试一次，不行就晚点再说" : "晚点我再试一次"}`);
      writePhotoFail(PHOTO_TOLD_KEY, { why, at: now });
    }
    return `没拍成：${why}`;
  }
  writePhotoFail(PHOTO_FAIL_KEY, null);
  writePhotoFail(PHOTO_TOLD_KEY, null);
  db()
    .prepare("INSERT OR IGNORE INTO album_photos(date, file, outfit, weather, caption, created_at) VALUES(?, ?, ?, ?, ?, ?)")
    .run(date, jpg, t.outfit.name, weatherText, plan.caption || "", Date.now());
  post(`${plan.caption || "今天的我～"}\n\n![今天](/api/wardrobe/${jpg})`);
  return "拍好了，已经放进相册，也发给他看了。";
}

/** 每天自动拍一张：白天、他今天来过，才拍（拍的时候他能看到） */
export async function dailyTick() {
  albumTable();
  // 顺手把实时天气刷一遍，聊天里那句天气提示就不用等网络
  void getWeather();
  const h = new Date().getHours();
  if (h < 9 || h >= 22) return;
  if (db().prepare("SELECT 1 FROM album_photos WHERE date = ?").get(dayKey())) return;
  const seen = db()
    .prepare("SELECT 1 FROM messages WHERE role = 'user' AND created_at > ? LIMIT 1")
    .get(new Date(new Date().toDateString()).getTime());
  if (!seen) return;
  await takeDailyPhoto();
}
