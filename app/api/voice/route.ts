import { asrReady, doubaoAsr } from "@/lib/doubao";
import {
  askForKey,
  publicMessage,
  putUserVoiceMessage,
  saveVoiceClip,
  sayNotHeard,
  setClipText,
  voiceMarkdown,
} from "@/lib/voicemsg";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 8 * 1024 * 1024;

function decode(dataUrl: string): Buffer | null {
  const m = dataUrl.match(/^data:audio\/[\w.+-]+;base64,(.+)$/);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], "base64");
    return buf.length > 64 && buf.length <= MAX_BYTES ? buf : null;
  } catch {
    return null;
  }
}

/**
 * 他发来一段语音（浏览器录的 16k 单声道 wav）：
 * 存下音频 → 豆包识别成文字 → 落成一条对话记录，回复交给平常那条链路。
 * 没配凭据、没听清，也都留一条记录并让敏说一句人话，不报错、不吞掉。
 */
export async function POST(req: Request) {
  let body: { audio?: string; seconds?: number; clientId?: string; mime?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }
  const { audio = "", clientId = "", mime = "audio/wav" } = body;
  const seconds = Math.max(0, Math.min(600, Number(body.seconds) || 0));
  if (!clientId) return Response.json({ ok: false, reason: "bad-request" }, { status: 400 });

  const buf = decode(audio);
  if (!buf) return Response.json({ ok: false, reason: "bad-audio" }, { status: 400 });

  const clip = saveVoiceClip({ buf, mime: mime.startsWith("audio/") ? mime : "audio/wav", seconds, kind: "in" });
  const mark = voiceMarkdown(clip.id);

  if (!asrReady()) {
    const user = putUserVoiceMessage(clientId, `${mark}\n\n（这段语音我还没法听，先存着）`);
    const reply = askForKey();
    return Response.json({ ok: false, reason: "missing", clipId: clip.id, user: publicMessage(user), reply: publicMessage(reply) });
  }

  const got = await doubaoAsr(buf);
  if (!got.ok) {
    const user = putUserVoiceMessage(clientId, `${mark}\n\n（这段语音没听清）`);
    const reply = sayNotHeard();
    return Response.json({ ok: false, reason: got.why, clipId: clip.id, user: publicMessage(user), reply: publicMessage(reply) });
  }

  setClipText(clip.id, got.text);
  const user = putUserVoiceMessage(clientId, `${got.text}\n\n${mark}`);
  return Response.json({ ok: true, clipId: clip.id, text: got.text, user: publicMessage(user) });
}