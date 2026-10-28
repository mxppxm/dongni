import fs from "node:fs";
import { moodFile } from "@/lib/moods";

export const dynamic = "force-dynamic";

/** 她自己画的样子（自带的在 /public/mood 下） */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const file = moodFile(key);
  if (!file || !fs.existsSync(file)) return new Response("not found", { status: 404 });
  const buf = fs.readFileSync(file);
  return new Response(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
