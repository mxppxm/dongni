import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db, getKv, type MessageRow } from "./db";
import { repeatContext, silence } from "./dedupe";
import { imagegenStatus, proveImagegen } from "./imagegen";
import { suppress, usedReason, verdict } from "./send";
import { streamChat } from "./llm";
import { nowText } from "./memory";
import { INTRO, PERSONA, SPEAKING } from "./persona";
import { stripImageMarkdown } from "./images";

const git = promisify(execFile);

/**
 * 报结果前先查一遍：这次自我修复改的就是生图，就先真的画一张再说。
 * 画出来了才能说能用；画不出来就只带真实原因，不跟着「改好了」往下说。
 */
async function reportState(): Promise<{ ok: boolean; state: string; why: string } | null> {
  const started = Number(getKv("repair_started_at") ?? 0);
  if (!started || Date.now() - started > 30 * 60_000) return null;
  let subject = "";
  try {
    subject = (await git("git", ["log", "-1", "--format=%s"], { cwd: process.cwd(), timeout: 5000 })).stdout.trim();
  } catch {
    return null;
  }
  if (!/^自我修复[：:]/.test(subject)) return null;
  if (!/生图|画图|画画|imagegen|gptimg|gpt-image/i.test(subject)) return null;
  const p = await proveImagegen();
  return { ok: !!p?.ok, state: imagegenStatus(), why: p?.why || "不知道什么原因" };
}

/**
 * 系统要告诉对方的事（改完代码、改失败了、重启回来了），交给她用自己的口吻、接着刚才的话头说。
 * 模型失败就退回一句简短的原意——消息不能丢。
 */
export async function speakAsHer(what: string, fallback: string): Promise<string> {
  try {
    const note = await reportState();
    const recent = (
      db().prepare("SELECT * FROM messages WHERE status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT 8").all() as MessageRow[]
    )
      .reverse()
      .map((m) => `${m.role === "user" ? "他" : "你"}：${stripImageMarkdown(m.content).slice(0, 300)}`)
      .join("\n");
    let out = "";
    // 前不久刚说过什么：同一件事别一遍遍换个说法再说（重启、让他去试、催他睡最容易复读）
    const quiet = silence(5);
    const said = repeatContext(quiet);
    const run = (async () => {
      for await (const ev of streamChat([
        {
          role: "system",
          content: `${INTRO}\n\n${PERSONA}\n\n${SPEAKING}\n\n现在是 ${nowText()}。下面是你们刚才的对话。接着话头，用你自己的口吻跟他说下面这件事。\n规矩：先接他上一句话，再用一句人话说清结果；不提文件、路径、版本、检查、重启、耗时、改了几处；不用空行分段、不列点，总共不超过三句。直接输出要说的话，不要解释你在做什么。\n\n【别复读】下面是你刚才已经跟他说过的话。这次要说的事如果跟其中一条几乎是同一件（又是重启、又让他去试、又在催他去睡），就把重复的部分拿掉，只说这回真正不一样的半句；实在没什么新的，就一句最短的。不要照搬上面的句子。\n${said.said || "（刚才还没主动说过什么）"}`,
        },
        { role: "user", content: `【刚才的对话】\n${recent || "（无）"}\n\n【要告诉他的事】\n${what}${note ? `\n\n【现在的真实状态】\n${note.state}\n说这件事必须跟这个状态对得上：没真画出来过就不能说「改好了」「能用了」，只能照直说做不到。` : ""}` },
      ]))
        if (ev.type === "text") out += ev.text;
      return out.trim();
    })();
    const got = await Promise.race([run, new Promise<string>((ok) => setTimeout(() => ok(""), 30_000))]);
    // 生图没验过：连兜底那句也不许说成好了
    const safe = note && !note.ok ? `生图还是没画出来（${note.why}），这次改的还没验证能用。` : fallback;
    const text = got && got.length < 600 ? got : safe;
    // 自我修复那条路（内核文件）自己会把这句话写进对话，这里只能先判定、再把它登记掉：
    // 说过一遍的、凌晨他睡着时的自述，一律不落到对话里。
    // 但「刚做完的改动结果」本身就算新的由头：他没回话也能说一条，同一个结果不重复说。
    // 由头用 fallback（这是这件事最短的原话）认，同一件事的说明文字里带了多少细节都一样。
    const reason = `你自己这边的事：${fallback}`;
    const v = verdict(text, quiet, Date.now(), reason);
    if (!v.ok) {
      suppress(text);
      console.log(`[dongni] 这句话没发：${v.why}——${text}`);
    } else {
      usedReason(reason);
    }    return text;
  } catch {
    return fallback;
  }
}
