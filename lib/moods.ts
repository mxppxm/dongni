import "server-only";
import { gptimgScript } from "./portable";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db, getKv, setKv } from "./db";
import { completeJson } from "./llm";
import { finishTask, startTask } from "./tasks";

/**
 * 她等你时的样子（loading）。
 * 自带 6 个；表达不了当下情绪时，她自己画一个新的：生成 → 自查 → 入库 → 下次就能用，并拿给对方看。
 */
const run = promisify(execFile);
const ROOT = process.cwd();
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(ROOT, "data");
const MOOD_DIR = path.join(DATA_DIR, "moods");
const ANCHOR = path.join(ROOT, "public", "mood", "anchor.png");
const GPTIMG = gptimgScript();

/** 动作和小特效：前端有对应的 CSS，新画的样子只能从这里面挑 */
export const PRESETS = ["ponder", "stride", "jump", "breathe", "scribble", "hi", "sway", "shake", "float"] as const;
export const FXS = ["bubbles", "wind", "sparks", "hearts", "line", "drops", "notes", "none"] as const;

export type Mood = { key: string; name: string; when_text: string; file: string; preset: string; fx: string; source: string; created_at: number };

const BASE: Omit<Mood, "created_at">[] = [
  { key: "think", name: "歪头想", when_text: "默认；对方随口一句、问问题、聊日常，你在琢磨怎么回", file: "public:think.png", preset: "ponder", fx: "bubbles", source: "base" },
  { key: "run", name: "跑腿", when_text: "你在查电脑、找文件、看东西，替对方跑腿", file: "public:run.png", preset: "stride", fx: "wind", source: "base" },
  { key: "cheer", name: "跟着蹦", when_text: "对方说了开心事、好消息、成功了，你替他高兴", file: "public:cheer.png", preset: "jump", fx: "sparks", source: "base" },
  { key: "comfort", name: "陪着", when_text: "对方累了、烦了、难过、焦虑、不舒服，你想安静陪着他", file: "public:comfort.png", preset: "breathe", fx: "hearts", source: "base" },
  { key: "draw", name: "画画", when_text: "你在给对方画图", file: "public:draw.png", preset: "scribble", fx: "line", source: "base" },
  { key: "wave", name: "招手", when_text: "打招呼：对方说你好、早、晚安、刚回来", file: "public:anchor.png", preset: "hi", fx: "none", source: "base" },
];

const g = globalThis as unknown as { __dongniMoodsReady?: boolean; __dongniMoodGen?: boolean; __dongniMoodGenName?: string };

/** 正在画的新样子（没有就是 null） */
export const moodGenerating = () => (g.__dongniMoodGen ? (g.__dongniMoodGenName ?? "新样子") : null);

function ready() {
  if (g.__dongniMoodsReady) return;
  db().exec(`CREATE TABLE IF NOT EXISTS moods (
    key TEXT PRIMARY KEY, name TEXT NOT NULL, when_text TEXT NOT NULL, file TEXT NOT NULL,
    preset TEXT NOT NULL, fx TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  const ins = db().prepare(
    "INSERT OR IGNORE INTO moods(key, name, when_text, file, preset, fx, source, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const m of BASE) ins.run(m.key, m.name, m.when_text, m.file, m.preset, m.fx, m.source, 0);
  g.__dongniMoodsReady = true;
}

export function listMoods(): Mood[] {
  ready();
  return db().prepare("SELECT * FROM moods ORDER BY created_at, key").all() as Mood[];
}

export function moodUrl(m: Mood) {
  return m.file.startsWith("public:") ? `/mood/${m.file.slice(7)}` : `/api/mood/${m.key}`;
}

export function moodFile(key: string): string | null {
  ready();
  const m = db().prepare("SELECT * FROM moods WHERE key = ?").get(key) as Mood | undefined;
  if (!m || m.file.startsWith("public:")) return null;
  return path.join(MOOD_DIR, m.file.replace(/^data:/, ""));
}

/* ---------------- 选样子 ---------------- */

type Pick = { mood?: string; create?: { name?: string; when?: string; pose?: string } };

/**
 * 看对方这句话，挑一个最贴她此刻心情的样子。很快（不思考），挑不出就用「歪头想」。
 * 现有的都表达不了、而且情绪很鲜明时，顺手在后台画一个新的（下次就能用）。
 */
export async function pickMood(userText: string, recent: string): Promise<string> {
  const moods = listMoods();
  try {
    const r = await Promise.race([
      completeJson<Pick>(
        [
          {
            role: "system",
            content: `你是一个 20 岁、活泼可爱好动的女生，对方刚给你发了消息，你在想怎么回。选一个最贴合你此刻心情的「等待时的样子」。
可选：
${moods.map((m) => `- ${m.key}：${m.name}（${m.when_text}）`).join("\n")}

只输出 JSON：{"mood":"key"}。
只有当你此刻的情绪非常鲜明、上面没有一个能表达（比如被逗得笑翻、害羞脸红、生气鼓腮、吃惊、委屈、困了……），才额外给出想要的新样子：
{"mood":"最接近的key","create":{"name":"两三个字","when":"什么时候用（一句话）","pose":"动作和表情（一句话，具体）"}}`,
          },
          { role: "user", content: `【刚才聊的】\n${recent}\n\n【对方刚说】\n${userText}` },
        ],
        300,
        "none",
      ),
      new Promise<Pick>((ok) => setTimeout(() => ok({}), 5000)),
    ]);
    if (r.create?.name && r.create.pose) void createMood(r.create.name, r.create.when ?? "", r.create.pose);
    return moods.some((m) => m.key === r.mood) ? r.mood! : "think";
  } catch {
    return "think";
  }
}

/* ---------------- 画一个新样子 ---------------- */

type Review = { pass?: boolean; issues?: string; preset?: string; fx?: string };

function counter() {
  const day = new Date().toLocaleDateString("sv-SE");
  const [d, n] = (getKv("mood_new_day") ?? "").split(":");
  const count = d === day ? Number(n) || 0 : 0;
  return { count, bump: () => setKv("mood_new_day", `${day}:${count + 1}`) };
}

const dataUrl = (file: string) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;

async function draw(pose: string, extra: string, out: string) {
  // 参考图放大一点再喂，人物更稳
  const ref = path.join(os.tmpdir(), "dongni-mood-anchor.png");
  if (!fs.existsSync(ref)) await run("/usr/bin/sips", ["-Z", "1024", ANCHOR, "--out", ref]);
  const prompt = `${pose}. Same character as the reference (same face, brown high messy ponytail with orange scrunchie, short bangs, mint-green hoodie), same flat chibi sticker style with clean warm-brown outline and soft cel shading, character fills most of the frame, isolated on a fully transparent background, no text, no frame. ${extra}`;
  await run(process.execPath, [GPTIMG, prompt, "--ref", ref, "-o", out, "--background", "transparent", "--quality", "medium", "--json"], {
    timeout: 6 * 60_000,
    maxBuffer: 20 << 20,
  });
}

/** 裁掉透明边、缩到 200px；顺便量一下四角是不是透明的 */
async function tidy(file: string): Promise<boolean> {
  const py = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGBA")
w, h = im.size
corners = [im.getpixel((2, 2))[3], im.getpixel((w - 3, 2))[3], im.getpixel((2, h - 3))[3], im.getpixel((w - 3, h - 3))[3]]
box = im.getbbox()
if box: im = im.crop(box)
im.thumbnail((200, 200), Image.LANCZOS)
im.save(sys.argv[1], optimize=True)
print("ok" if max(corners) < 20 else "opaque")
`;
  try {
    const { stdout } = await run("/usr/bin/python3", ["-c", py, file], { timeout: 60_000 });
    return stdout.trim() === "ok";
  } catch {
    // 新电脑上可能没有 Python 的图片库：只缩小尺寸，透明与否交给自查那一步看
    await run("/usr/bin/sips", ["-Z", "200", file, "--out", file]).catch(() => {});
    return true;
  }
}

async function review(file: string, name: string, pose: string): Promise<Review> {
  return completeJson<Review>(
    [
      {
        role: "system",
        content: `你在验收一张新画的表情贴纸，它会作为聊天里「她在等你回话时的样子」，只有 44px 大。第一张是她的标准形象，第二张是新画的。
逐条检查：1) 是同一个人（脸、马尾和橙色发圈、薄荷绿卫衣、画风一致）；2) 表情动作清楚表达「${name}：${pose}」，缩到很小也看得出；3) 没有文字、水印、边框、多余的人或背景；4) 画得干净，没有崩坏的手脚五官。
全部合格才 pass=true。再给它挑一个动作 preset（${PRESETS.join("/")}）和一个小特效 fx（${FXS.join("/")}），要配这个情绪。
只输出 JSON：{"pass":true/false,"issues":"不合格的地方，一句话","preset":"...","fx":"..."}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "标准形象 / 新画的：" },
          { type: "image_url", image_url: { url: dataUrl(ANCHOR) } },
          { type: "image_url", image_url: { url: dataUrl(file) } },
        ],
      },
    ],
    600,
    "low",
  );
}

/** 生成 → 自查（不过就带着意见重画一次）→ 入库 → 用她的口吻拿给对方看 */
export async function createMood(name: string, when: string, pose: string) {
  if (g.__dongniMoodGen) return;
  const c = counter();
  const clean = name.trim().slice(0, 8);
  if (!clean || listMoods().some((m) => m.name === clean)) return;
  g.__dongniMoodGen = true;
  g.__dongniMoodGenName = clean;
  c.bump();
  fs.mkdirSync(MOOD_DIR, { recursive: true });
  const key = `m${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const out = path.join(MOOD_DIR, `${key}.png`);
  const taskId = startTask("create_mood", `画新表情「${clean}」`);
  let made = false;
  try {
    let feedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      await draw(pose, feedback ? `Fix these problems from the last try: ${feedback}` : "", out);
      const transparent = await tidy(out);
      const r = await review(out, clean, pose);
      const ok = r.pass && transparent;
      console.log(`[dongni] 新样子「${clean}」第 ${attempt + 1} 次自查：${ok ? "通过" : `不过（${transparent ? r.issues : "背景不透明"}）`}`);
      if (ok) {
        const preset = (PRESETS as readonly string[]).includes(r.preset ?? "") ? r.preset! : "sway";
        const fx = (FXS as readonly string[]).includes(r.fx ?? "") ? r.fx! : "none";
        db()
          .prepare("INSERT INTO moods(key, name, when_text, file, preset, fx, source, created_at) VALUES(?, ?, ?, ?, ?, ?, 'gen', ?)")
          .run(key, clean, when || pose, `data:${key}.png`, preset, fx, Date.now());
        await show(key, clean, pose);
        made = true;
        return;
      }
      feedback = transparent ? (r.issues ?? "") : "background must be fully transparent";
    }
    fs.rmSync(out, { force: true });
  } catch (e) {
    console.warn("[dongni] 画新样子失败：", e instanceof Error ? e.message : e);
    fs.rmSync(out, { force: true });
  } finally {
    finishTask(taskId, made, made ? `![${clean}](/api/mood/${key})` : "两次自查都没过，没入库");
    g.__dongniMoodGen = false;
  }
}

/** 拿给对方看：一句她自己的话 + 新样子 */
async function show(key: string, name: string, pose: string) {
  const { speakAsHer } = await import("./speak");
  const line = await speakAsHer(
    `刚才你心里那个情绪，现有的样子都表达不了，你就自己给自己画了一个新的「${name}」（${pose}），以后这种时候就用它。开心地拿给他看一眼，一句话。`,
    `给自己画了个新样子「${name}」，以后这种时候就用它～`,
  );
  db()
    .prepare("INSERT INTO messages(role, content, status, extracted, created_at) VALUES('assistant', ?, 'done', 1, ?)")
    .run(`${line}\n\n![${name}](/api/mood/${key})`, Date.now());
}
