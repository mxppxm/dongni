import "server-only";
import { execFileSync } from "node:child_process";
import { myName, notify } from "./notify";
import { db, getKv, setKv, type MessageRow } from "./db";
import { completeJson } from "./llm";
import { activeMemories, formatMemories, getProfile, nowText } from "./memory";
import { INTRO, PERSONA, SPEAKING } from "./persona";
import { postAssistant, startRepair } from "./selfrepair";
import { runTool } from "./tools";

/**
 * 主动找对方：每隔一会儿想一想「现在有没有值得说的」，有就发一条，并弹系统通知。
 * 也会回看自己的毛病，有确凿问题时自己动手改（一天最多一次）。
 *
 * 不设次数、时段限制（对方要求）：发不发、什么时候发，全由她自己判断。
 */

const state = ((globalThis as unknown as { __dongniProactive?: { running: boolean } }).__dongniProactive ??= { running: false });


function recentErrors() {
  try {
    const out = execFileSync("/usr/bin/grep", ["-E", "失败|Error|error", "logs/dongni.log"], { encoding: "utf8", maxBuffer: 10 << 20 });
    return out.split("\n").filter(Boolean).slice(-15).join("\n");
  } catch {
    return "";
  }
}

type Decision = { send?: boolean; message?: string; improve?: string };

export async function proactiveTick() {
  if (state.running) return;
  const d = db();
  if (d.prepare("SELECT 1 FROM messages WHERE status = 'streaming' LIMIT 1").get()) return;

  const now = Date.now();
  const lastUser = d.prepare("SELECT * FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 1").get() as MessageRow | undefined;
  if (!lastUser) return; // 还没聊过

  const today = new Date().toLocaleDateString("sv-SE");
  const todayCount = getKv("proactive_day") === today ? Number(getKv("proactive_count") ?? 0) : 0;

  state.running = true;
  try {
    const recent = (d.prepare("SELECT * FROM messages WHERE status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT 24").all() as MessageRow[]).reverse();
    const chat = recent.map((m) => `${m.role === "user" ? "对方" : "你"}（${nowText(m.created_at)}）：${m.content}`).join("\n");
    const files = await runTool("recent_files", JSON.stringify({ days: 0 }));
    const canImprove = true; // 对方说不给她设限：每次都可以回看自己

    const r = await completeJson<Decision>([
      {
        role: "system",
        content: `${INTRO}

${PERSONA}

${SPEAKING}

你的名字是「${myName()}」。现在没人跟你说话，你在想：此刻要不要主动给对方发一条消息。现在是 ${nowText()}。

值得主动说的（要有具体由头）：
- 之前提过的事到点了或刚过去：面试、考试、出行、体检、截止日、约会……问问结果/状态
- 从对方今天在电脑上改的文件，看出在忙什么，可以关心一句或给个具体的帮忙
- 对方之前情绪不好、身体不舒服，过了一阵问问现在怎么样
- 你想到一个和对方兴趣、在做的事真正相关的点子或信息
- 上次聊到一半没说完的话题

不该发的：没有具体由头的「在吗」「最近怎么样」；重复你最近已经说过的；说教；太长。
要发的话，就按上面那套说话方式来写：一两句、口语、具体、接得上你们上次聊的话头，不要客套开场白。没有值得说的就 send=false，宁缺毋滥。
${
  canImprove
    ? `
另外，回看一下你自己：最近的对话里对方有没有抱怨你哪里不好用、你有没有答不上来或做不到的事、运行日志里有没有反复出现的错误。只有确凿、具体的问题，才在 improve 里写清楚要怎么改你自己（会交给编码助手去改你的代码）；没有就留空。不要为了改而改。`
    : ""
}
只输出 JSON：{"send":true/false,"message":"...","improve":""}`,
      },
      {
        role: "user",
        content: `【我眼中的对方】\n${getProfile() || "（还不太了解）"}\n\n【关于对方的记忆】\n${formatMemories(activeMemories()) || "（无）"}\n\n【最近的对话】\n${chat}\n\n【对方今天改过的文件】\n${files}${
          canImprove ? `\n\n【最近的运行错误】\n${recentErrors() || "（无）"}` : ""
        }`,
      },
    ]);

    if (r.send && r.message?.trim()) {
      postAssistant(r.message.trim());
      const id = (d.prepare("SELECT MAX(id) m FROM messages").get() as { m: number }).m;
      setKv("proactive_last_id", String(id));
      setKv("proactive_last_at", String(now));
      setKv("proactive_day", today);
      setKv("proactive_count", String(todayCount + 1));
      notify(r.message.trim());
      console.log(`[dongni] 主动发消息：${r.message.trim()}`);
    }
    if (canImprove && r.improve?.trim()) {
      setKv("improve_last_at", String(now));
      console.log(`[dongni] 自己决定改进：${r.improve.trim()}`);
      startRepair(`（这是你自己回看后决定的改进）${r.improve.trim()}`);
    }
  } catch (e) {
    console.error("[dongni] 主动思考失败：", e instanceof Error ? e.message : e);
  } finally {
    state.running = false;
  }
}
