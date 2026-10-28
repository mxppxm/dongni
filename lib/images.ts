import "server-only";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db";

/**
 * 对话里的图片：统一存到 data/images，库里只记一条索引。
 * 消息正文里用 `![](/api/image/<编号>)` 引用（是链接，不是磁盘路径），前端直接渲染。
 */
const DATA_DIR = process.env.DONGNI_DATA_DIR || path.join(process.cwd(), "data");
const IMAGE_DIR = path.join(DATA_DIR, "images");
const MAX_EDGE = 1600;

export type ImageRec = {
  id: number;
  file: string;
  mime: string;
  kind: string;
  src: string | null;
  prompt: string | null;
  created_at: number;
};

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heic",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
};

/** 能被当成图看的扩展名 */
export const IMAGE_EXT = new Set(Object.keys(MIME));

const g = globalThis as unknown as { __dongniImagesReady?: boolean };

function table() {
  if (g.__dongniImagesReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL,
      mime TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'gen',
      src TEXT,
      prompt TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_images_src ON images(src);
  `);
  g.__dongniImagesReady = true;
}

const mimeOfExt = (ext: string) => MIME[ext.toLowerCase()] ?? "application/octet-stream";
const extOfMime = (mime: string) => Object.keys(MIME).find((e) => MIME[e] === mime) ?? ".png";

function insert(file: string, mime: string, kind: string, src: string | null, prompt: string | null): ImageRec {
  const now = Date.now();
  const id = Number(
    db().prepare("INSERT INTO images(file, mime, kind, src, prompt, created_at) VALUES(?, ?, ?, ?, ?, ?)").run(file, mime, kind, src, prompt, now)
      .lastInsertRowid,
  );
  return { id, file, mime, kind, src, prompt, created_at: now };
}

/** 统一落盘：能转就转成规整的 jpeg（图太大或 heic 时浏览器也能看），gif 保留原样 */
function finalize(source: string, ext: string, stem: string): { file: string; mime: string } {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  if (ext === ".gif") {
    const file = `${stem}.gif`;
    fs.copyFileSync(source, path.join(IMAGE_DIR, file));
    return { file, mime: "image/gif" };
  }
  const jpeg = `${stem}.jpg`;
  try {
    execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", String(MAX_EDGE), source, "--out", path.join(IMAGE_DIR, jpeg)], {
      stdio: "ignore",
      timeout: 30_000,
    });
    return { file: jpeg, mime: "image/jpeg" };
  } catch {
    const file = `${stem}${ext || ".png"}`;
    fs.copyFileSync(source, path.join(IMAGE_DIR, file));
    return { file, mime: mimeOfExt(ext) };
  }
}

export const imageMarkdown = (id: number) => `![](/api/image/${id})`;

export function getImage(id: number): ImageRec | null {
  if (!Number.isFinite(id)) return null;
  table();
  return (db().prepare("SELECT * FROM images WHERE id = ?").get(id) as ImageRec | undefined) ?? null;
}

export const imagePath = (rec: ImageRec) => path.join(IMAGE_DIR, rec.file);

/** 电脑里已有的图：同一张只存一份 */
export function addLocalImage(file: string): ImageRec {
  table();
  const st = fs.statSync(file);
  const src = `${file}@${st.mtimeMs}:${st.size}`;
  const existed = db().prepare("SELECT * FROM images WHERE src = ?").get(src) as ImageRec | undefined;
  if (existed) return existed;
  const ext = path.extname(file).toLowerCase();
  const stem = `local-${crypto.createHash("sha1").update(src).digest("hex").slice(0, 12)}`;
  const saved = finalize(file, ext, stem);
  return insert(saved.file, saved.mime, "local", src, null);
}

/** 对方发来的图 / 自己画的图 */
export function addImageBuffer(buf: Buffer, mime: string, kind: "user" | "gen", prompt: string | null = null): ImageRec {
  table();
  const ext = extOfMime(mime);
  const stem = `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const tmp = path.join(os.tmpdir(), `dongni-${stem}${ext}`);
  fs.writeFileSync(tmp, buf);
  try {
    const saved = finalize(tmp, ext, stem);
    return insert(saved.file, saved.mime, kind, null, prompt);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 正文里引用了哪些图 */
export function imageIdsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(\/api\/image\/(\d+)\)/g)) {
    const id = Number(m[1]);
    if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 交给模型或记忆时把图片引用去掉，只留文字 */
export function stripImageMarkdown(text: string) {
  return text
    .replace(/!\[[^\]]*\]\(\/api\/image\/\d+\)/g, "")
    .replace(/!\[[^\]]*\]\(data:image\/[^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 给模型看的图：data URL；太大的先压一下 */
export function imageDataUrl(rec: ImageRec): string | null {
  try {
    const file = imagePath(rec);
    let buf = fs.readFileSync(file);
    if (buf.length > 3 << 20) {
      const small = path.join(os.tmpdir(), `dongni-small-${rec.id}.jpg`);
      try {
        execFileSync("/usr/bin/sips", ["-Z", "1280", "-s", "format", "jpeg", file, "--out", small], { stdio: "ignore", timeout: 30_000 });
        buf = fs.readFileSync(small);
      } finally {
        fs.rmSync(small, { force: true });
      }
    }
    return `data:${rec.mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 对方发来的图：data URL → 落盘 */
export function addUploadedImage(dataUrl: string): ImageRec | null {
  const m = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > 12 << 20) return null;
  return addImageBuffer(buf, m[1].toLowerCase(), "user");
}