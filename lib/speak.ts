import "server-only";
import { db, type MessageRow } from "./db";
import { streamChat } from "./llm";
import { nowText } from "./memory";
import { INTRO, PERSONA, SPEAKING } from "./persona";
import { stripImageMarkdown } from "./images";

/**
 * 系统要告诉对方的事（改完代码、改失败了、重启回来了），交给她用自己的口吻、接着刚才的话头说。
 * 模型失败就退回一句简短的原意——消息不能丢。
 */
export async function speakAsHer(what: string, fallback: string): Promise<string> {
  try {
    const recent = (
      db().prepare("SELECT * FROM messages WHERE status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT 8").all() as MessageRow[]
    )
      .reverse()
      .map((m) => `${m.role === "user" ? "他" : "你"}：${stripImageMarkdown(m.content).slice(0, 300)}`)
      .join("\n");
    let out = "";
    const run = (async () => {
      for await (const ev of streamChat([
        {
          role: "system",
          content: `${INTRO}\n\n${PERSONA}\n\n${SPEAKING}\n\n现在是 ${nowText()}。下面是你们刚才的对话。接着话头，用你自己的口吻跟他说下面这件事。\n规矩：先接他上一句话，再用一句人话说清结果；不提文件、路径、版本、检查、重启、耗时、改了几处；不用空行分段、不列点，总共不超过三句。直接输出要说的话，不要解释你在做什么。`,
        },
        { role: "user", content: `【刚才的对话】\n${recent || "（无）"}\n\n【要告诉他的事】\n${what}` },
      ]))
        if (ev.type === "text") out += ev.text;
      return out.trim();
    })();
    const said = await Promise.race([run, new Promise<string>((ok) => setTimeout(() => ok(""), 30_000))]);
    return said && said.length < 600 ? said : fallback;
  } catch {
    return fallback;
  }
}
