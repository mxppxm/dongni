import "server-only";
import { db, getKv, setKv } from "./db";
import { completeJson } from "./llm";

/**
 * 相册里她画的图：配一句像日记的话。聊天里的原话常常是「画好了」「就生图那件事啊」，放相册里不像话，
 * 所以按画的内容单独写一句，写过就存着。
 */
const busy = globalThis as unknown as { __dongniCaptioning?: boolean };

export function captionOf(imageId: number): string {
  return getKv(`img_caption_${imageId}`) ?? "";
}

export async function fillCaptions() {
  if (busy.__dongniCaptioning) return;
  busy.__dongniCaptioning = true;
  try {
    const rows = db().prepare("SELECT id, prompt FROM images WHERE kind = 'gen' ORDER BY id").all() as { id: number; prompt: string | null }[];
    for (const r of rows) {
      if (captionOf(r.id) || !r.prompt) continue;
      try {
        const out = await completeJson<{ caption: string }>(
          [
            {
              role: "system",
              content:
                "你是一个 20 岁、活泼的女生，在给自己相册里的一张图写一句配文，像随手写的日记：中文，口语，十五到二十五个字，不要引号、不要表情、不要提「画」「生成」「AI」。只输出 JSON：{\"caption\":\"...\"}",
            },
            { role: "user", content: `这张图的内容：${r.prompt.slice(0, 600)}` },
          ],
          200,
          "none",
        );
        if (out.caption?.trim()) setKv(`img_caption_${r.id}`, out.caption.trim().slice(0, 40));
      } catch {
        // 下次再补
      }
    }
  } finally {
    busy.__dongniCaptioning = false;
  }
}
