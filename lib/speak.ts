import "server-only";
import { db, type MessageRow } from "./db";
import { repeatContext, silence } from "./dedupe";
import { suppress, verdict } from "./send";
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
    // 前不久刚说过什么：同一件事别一遍遍换个说法再说（重启、让他去试、催他睡最容易复读）
    const said = repeatContext(silence(5));
    const run = (async () => {
      for await (const ev of streamChat([
        {
          role: "system",
          content: `${INTRO}\n\n${PERSONA}\n\n${SPEAKING}\n\n现在是 ${nowText()}。下面是你们刚才的对话。接着话头，用你自己的口吻跟他说下面这件事。\n规矩：先接他上一句话，再用一句人话说清结果；不提文件、路径、版本、检查、重启、耗时、改了几处；不用空行分段、不列点，总共不超过三句。直接输出要说的话，不要解释你在做什么。\n\n【别复读】下面是你刚才已经跟他说过的话。这次要说的事如果跟其中一条几乎是同一件（又是重启、又让他去试、又在催他去睡），就把重复的部分拿掉，只说这回真正不一样的半句；实在没什么新的，就一句最短的。不要照搬上面的句子。\n${said.said || "（刚才还没主动说过什么）"}`,
        },
        { role: "user", content: `【刚才的对话】\n${recent || "（无）"}\n\n【要告诉他的事】\n${what}` },
      ]))
        if (ev.type === "text") out += ev.text;
      return out.trim();
    })();
    const got = await Promise.race([run, new Promise<string>((ok) => setTimeout(() => ok(""), 30_000))]);
    const text = got && got.length < 600 ? got : fallback;
    // 自我修复那条路（内核文件）自己会把这句话写进对话，这里只能先判定、再把它登记掉：
    // 说过一遍的、他连着几条没回的、凌晨他睡着时候的自述，一律不落到对话里。
    const v = verdict(text);
    if (!v.ok) {
      suppress(text);
      console.log(`[dongni] 这句话没发：${v.why}——${text}`);
    }
    return text;
  } catch {
    return fallback;
  }
}
