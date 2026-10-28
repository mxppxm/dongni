import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, getKv, setKv } from "./db";
import { completeJson } from "./llm";
import { nowText } from "./memory";
import { INTRO, PERSONA } from "./persona";

/**
 * 衣橱和相册。
 * 衣橱：几套固定造型，每套一张定妆照（3D 写实、全身、能看到鞋）。穿哪套由「时间 × 季节 × 天气」按规则算，不随机。
 * 相册：一天一张，穿当天那套，配日期、天气、她写的一句话。拍之前先在对话里说一声。
 */
const run = promisify(execFile);
const ROOT = process.cwd();
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(ROOT, "data");
const DIR = path.join(DATA_DIR, "wardrobe");
const GPTIMG = path.join(os.homedir(), ".agents", "skills", "gptimg", "scripts", "gptimg.mjs");
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

export type Weather = { city: string; temp: number; text: string; kind: "sun" | "cloud" | "rain" | "snow" | "unknown" };

let weatherCache: { at: number; city: string; w: Weather | null } | null = null;

export function getCity() {
  return getKv("weather_city") ?? "";
}

export function setCity(city: string) {
  setKv("weather_city", city.trim());
  weatherCache = null;
}

export async function getWeather(): Promise<Weather | null> {
  const city = getCity();
  if (!city) return null;
  if (weatherCache && weatherCache.city === city && Date.now() - weatherCache.at < 3600_000) return weatherCache.w;
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`, { signal: AbortSignal.timeout(15_000) });
    const j = await res.json();
    const c = j.current_condition[0];
    const code = Number(c.weatherCode);
    const SNOW = [179, 227, 230, 323, 326, 329, 332, 335, 338, 350, 368, 371, 374, 377, 392, 395];
    const kind: Weather["kind"] =
      code === 113 ? "sun" : [116, 119, 122, 143, 248, 260].includes(code) ? "cloud" : SNOW.includes(code) ? "snow" : "rain";
    const text = c.lang_zh?.[0]?.value || c.weatherDesc?.[0]?.value || "";
    const w: Weather = { city, temp: Number(c.temp_C), text, kind };
    weatherCache = { at: Date.now(), city, w };
    return w;
  } catch {
    weatherCache = { at: Date.now(), city, w: null };
    return null;
  }
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
  const cold = w ? w.temp < 12 : season() === "冬";
  if (cold) return byKey("cold");
  return byKey("sunny");
}

export async function today() {
  const w = await getWeather();
  const outfit = pickOutfit(w);
  return { weather: w, outfit, season: season() };
}

/** 写进她的系统提示词：她知道自己今天穿什么、外面什么天 */
export async function wardrobeNote() {
  const t = await today();
  const city = getCity();
  return `你今天穿的是「${t.outfit.name}」那身。现在是${t.season}天${
    t.weather ? `，${city}${t.weather.text}，${t.weather.temp}°C` : city ? "（天气暂时没查到）" : ""
  }。${city ? "" : "你还不知道他在哪个城市，聊天时自然地问一句，知道了就用 set_city 记下（衣服会跟着那边的天气换）。"}`;
}

/* ---------------- 画图 ---------------- */

async function draw(prompt: string, refs: string[], out: string, size = "1024x1536") {
  const args = [GPTIMG, prompt, "-o", out, "--size", size, "--quality", "high", "--json"];
  for (const r of refs) args.push("--ref", r);
  await run(process.execPath, args, { timeout: 10 * 60_000, maxBuffer: 20 << 20 });
  await run("/usr/bin/sips", ["-Z", "1400", "-s", "format", "jpeg", out, "--out", out.replace(/\.png$/, ".jpg")]);
  fs.rmSync(out, { force: true });
}

const g = globalThis as unknown as { __dongniWardrobeBusy?: boolean };

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
      await draw(
        `Same girl as the reference (same face, hair, scrunchie, proportions, same rendering style). ${STYLE}. Fashion lookbook shot, she is wearing ${o.wear}. Standing pose full of energy, plain soft light-grey studio background.`,
        [ANCHOR3D.replace(/\.png$/, ".jpg")],
        file,
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

export type Photo = { date: string; outfit: string; weather: string; caption: string; file: string; created_at: number };

function albumTable() {
  db().exec(`CREATE TABLE IF NOT EXISTS album (
    date TEXT PRIMARY KEY, outfit TEXT NOT NULL, weather TEXT NOT NULL, caption TEXT NOT NULL, file TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
}

export function listPhotos(): Photo[] {
  albumTable();
  return db().prepare("SELECT * FROM album ORDER BY date DESC").all() as Photo[];
}

const dayKey = (d = new Date()) => d.toLocaleDateString("sv-SE");

function post(content: string) {
  db()
    .prepare("INSERT INTO messages(role, content, status, extracted, created_at) VALUES('assistant', ?, 'done', 1, ?)")
    .run(content, Date.now());
}

/**
 * 今天这张：先说一声 → 拍（穿当天那套）→ 入相册 → 拿给他看。
 * force=true 是他让拍的（今天已经有了也重拍）。
 */
export async function takeDailyPhoto(force = false): Promise<string> {
  albumTable();
  const date = dayKey();
  if (!force && db().prepare("SELECT 1 FROM album WHERE date = ?").get(date)) return "今天已经拍过了。";
  if (g.__dongniWardrobeBusy) return "衣橱还在准备，等一会儿再拍。";
  const ref = path.join(DIR, `${(await today()).outfit.key}.jpg`);
  if (!fs.existsSync(ref)) {
    void ensureWardrobe();
    return "衣橱的定妆照还没做好，正在做，做好了再拍。";
  }
  const t = await today();
  const weatherText = t.weather ? `${t.weather.city} ${t.weather.text} ${t.weather.temp}°C` : `${t.season}天`;

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

  post(plan.before || "今天的照片我去拍一张～");
  const file = `album-${date}-${Date.now().toString(36)}.png`;
  try {
    await draw(
      `Same girl wearing exactly the same outfit as the reference image (same face, hair, scrunchie, clothes, shoes, same rendering style). ${STYLE}. ${plan.scene}`,
      [ref],
      path.join(DIR, file),
    );
  } catch (e) {
    post("诶，照片没拍出来……晚点我再试一次");
    return `没拍成：${e instanceof Error ? e.message : e}`;
  }
  const jpg = file.replace(/\.png$/, ".jpg");
  db()
    .prepare("INSERT OR REPLACE INTO album(date, outfit, weather, caption, file, created_at) VALUES(?, ?, ?, ?, ?, ?)")
    .run(date, t.outfit.name, weatherText, plan.caption || "", jpg, Date.now());
  post(`${plan.caption || "今天的我～"}\n\n![今天](/api/wardrobe/${jpg})`);
  return "拍好了，已经放进相册，也发给他看了。";
}

/** 每天自动拍一张：白天、他今天来过，才拍（拍的时候他能看到） */
export async function dailyTick() {
  albumTable();
  const h = new Date().getHours();
  if (h < 9 || h >= 22) return;
  if (db().prepare("SELECT 1 FROM album WHERE date = ?").get(dayKey())) return;
  const seen = db()
    .prepare("SELECT 1 FROM messages WHERE role = 'user' AND created_at > ? LIMIT 1")
    .get(new Date(new Date().toDateString()).getTime());
  if (!seen) return;
  await takeDailyPhoto();
}
