import fs from "node:fs";
import { getImage, imagePath } from "@/lib/images";

export const dynamic = "force-dynamic";

/** 对话里的图片：按编号取本地文件，图片自己带缓存头，翻历史不会重复拉 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rec = getImage(Number(id));
  if (!rec) return new Response("not found", { status: 404 });
  try {
    const buf = fs.readFileSync(imagePath(rec));
    const body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Content-Type": rec.mime,
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}