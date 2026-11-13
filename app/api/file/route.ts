import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";

const abs = (p: string) => path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/** 网页才让在浏览器里打开；不是网页的文件一律不许 */
const isHtml = (p: string) => /\.html?$/i.test(p);

/** 交给系统默认浏览器开一个新标签页（/usr/bin/open 不给参数就是浏览器本体），不嵌在当前窗口里、也不下载 */
function openInBrowser(file: string) {
  return new Promise<string>((ok) => {
    execFile("/usr/bin/open", ["--", file], { timeout: 15_000 }, (err) => ok(err ? (err.message || "打不开").replace(/\s+/g, " ").trim() : ""));
  });
}

/** 文件卡片要知道名字、大小和修改时间 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams.get("path") || "";
  if (!p.trim()) return Response.json({ ok: false });
  try {
    const file = abs(p);
    const st = fs.statSync(file);
    return Response.json({ ok: true, name: path.basename(file), size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() });
  } catch {
    return Response.json({ ok: false });
  }
}

/**
 * 默认是「在 Finder 中显示」。
 * - action=open：在浏览器里打开一个本机网页文件。只认真实存在、名字以 .html/.htm 结尾的文件（绝对路径、~、相对主目录都行）；
 * - action=save-html：正文里的 html 代码块先落成一个临时文件（每次新的随机目录），再拿它去打开。
 * 除此之外一律不打，也不执行任何东西。
 */
export async function POST(req: Request) {
  const { path: p, action, html } = (await req.json()) as { path?: string; action?: string; html?: string };

  if (action === "save-html") {
    if (typeof html !== "string" || !html.trim()) return Response.json({ ok: false, msg: "没有能打开的网页内容" });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dongni-html-"));
      const file = path.join(dir, "page.html");
      fs.writeFileSync(file, html, "utf8");
      return Response.json({ ok: true, path: file });
    } catch (e) {
      return Response.json({ ok: false, msg: e instanceof Error ? e.message : "没存下来" });
    }
  }

  if (!p?.trim()) return Response.json({ ok: false });
  const file = abs(p);

  if (action === "open") {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return Response.json({ ok: false, msg: "这个文件不在了" });
    }
    if (!st.isFile()) return Response.json({ ok: false, msg: "这是个文件夹，不是文件" });
    if (!isHtml(file)) return Response.json({ ok: false, msg: "只有网页文件能在浏览器里打开" });
    const err = await openInBrowser(file);
    return Response.json(err ? { ok: false, msg: `没打开：${err.slice(0, 80)}` } : { ok: true });
  }

  if (!fs.existsSync(file)) return Response.json({ ok: false });
  execFile("/usr/bin/open", ["-R", file], () => {});
  return Response.json({ ok: true });
}