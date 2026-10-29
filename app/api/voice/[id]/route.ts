import fs from "node:fs";
import { db, type MessageRow } from "@/lib/db";
import { synthesize, voiceStream } from "@/lib/tts";

export const dynamic = "force-dynamic";

/** 念一条回复：第一次点的时候合成，存到本地后直接回放 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const num = Number(id);
  if (!Number.isFinite(num)) return new Response("not found", { status: 404 });
  const row = db().prepare("SELECT * FROM messages WHERE id = ? AND role = 'assistant'").get(num) as MessageRow | undefined;
  if (!row?.content?.trim()) return new Response("not found", { status: 404 });

  // 豆包：边合成边放，第一段声音不到一秒就到
  const live = voiceStream(num, row.content);
  if (live && typeof live !== "string") {
    return new Response(live, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  }

  let file: string | null = typeof live === "string" ? live : null;
  try {
    if (!file) file = await synthesize(num, row.content);
  } catch {
    file = null;
  }
  if (!file) return new Response("unavailable", { status: 503 });
  try {
    const buf = fs.readFileSync(file);
    const body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("unavailable", { status: 503 });
  }
}