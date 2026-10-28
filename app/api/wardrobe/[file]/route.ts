import fs from "node:fs";
import { wardrobeFile } from "@/lib/wardrobe";

export const dynamic = "force-dynamic";

/** 衣橱定妆照、相册照片 */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const f = wardrobeFile(file);
  if (!f) return new Response("not found", { status: 404 });
  const buf = fs.readFileSync(f);
  return new Response(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
