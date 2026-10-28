import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";

const abs = (p: string) => path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

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

/** 「在 Finder 中显示」 */
export async function POST(req: Request) {
  const { path: p } = (await req.json()) as { path?: string };
  if (!p?.trim()) return Response.json({ ok: false });
  const file = abs(p);
  if (!fs.existsSync(file)) return Response.json({ ok: false });
  execFile("/usr/bin/open", ["-R", file], () => {});
  return Response.json({ ok: true });
}