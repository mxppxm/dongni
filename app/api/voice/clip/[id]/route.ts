import fs from "node:fs";
import { getVoiceClip, voiceClipPath } from "@/lib/voicemsg";

export const dynamic = "force-dynamic";

/** 对话里的语音：按编号取本地音频。认 Range，Safari 拖动进度条、续播都要它 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rec = getVoiceClip(Number(id));
  if (!rec) return new Response("not found", { status: 404 });

  let buf: Buffer;
  try {
    buf = fs.readFileSync(voiceClipPath(rec));
  } catch {
    return new Response("not found", { status: 404 });
  }
  const total = buf.byteLength;
  const mime = rec.mime || "audio/wav";
  const range = req.headers.get("range");
  const m = range?.match(/bytes=(\d*)-(\d*)/);

  if (m) {
    const start = m[1] ? Math.max(0, Number(m[1])) : 0;
    const end = m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
    if (!(start <= end) || start >= total) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    const slice = buf.subarray(start, end + 1);
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  return new Response(buf as unknown as BodyInit, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}