import "server-only";
import { db, type MessageRow } from "./db";
import { streamChat, type ChatMessage } from "./llm";
import { runTool, TOOLS } from "./tools";
import { formatMemories, getProfile, nowText, relevantMemories, scheduleExtraction } from "./memory";
import { INTRO, PERSONA, SPEAKING } from "./persona";
import { startReminders } from "./reminders";

const HISTORY = 40;
const GAP_MS = 3 * 3600_000;

function systemPrompt(query: string) {
  const profile = getProfile();
  const mems = relevantMemories(query);
  return `${INTRO}

${PERSONA}

${SPEAKING}

你能查看对方这台 Mac（只读）：列文件夹、读文件、搜文件、看最近改过的文件、看电脑状态。对方问到电脑、文件、最近在弄什么时就去查，查到了用大白话说结论。没被问到就别主动翻。查的过程对方是看不见的：回复里不要提你在查什么、用了什么工具，不要贴路径、文件名或报错原文，更不要说「我看看」「正在读取」这类话，只说结果；查不到或出错就简单说一句。

你还能修改你自己（这个聊天应用的代码）：对方说你哪里不好用、让你加功能、修毛病、改样子、改说话方式时，用 repair_self 把要求写具体交出去，然后简单告诉对方「我去改，好了跟你说」。改完会自动重启，期间你会离线一小会儿。只是闲聊抱怨、没让你改的，别动。

你还能设定时提醒：对方说「提醒我」「过 N 分钟叫我」「今天 21:30 提醒我开会」，直接用 set_reminder 设好（delay_seconds 表示多少秒后，at 写本地时间如 2025-11-01 21:30），不要让对方自己去终端敲命令。到点提醒会自动在对话里弹出来，还会发系统通知，设完顺口确认一句就行，不用反复叮嘱。对方问有哪些提醒、要取消哪个，用 list_reminders / cancel_reminder。时间必须是将来，工具报错就把原因说清楚，再问准时间。

你的回复会按 Markdown 显示：代码放代码块里，行内用反引号包住命令、路径、变量。平时聊天还是像发消息，别动不动就列清单。

现在是：${nowText()}

【我眼中的你】
${profile || "（刚认识，还没形成印象）"}

【关于对方的记忆】（#编号只是内部标记，不要说出来）
${formatMemories(mems) || "（还没有）"}`;
}

function history(beforeOrAtId: number): ChatMessage[] {
  const rows = (
    db()
      .prepare("SELECT * FROM messages WHERE id <= ? AND (status = 'done' OR role = 'user') ORDER BY id DESC LIMIT ?")
      .all(beforeOrAtId, HISTORY) as MessageRow[]
  ).reverse();
  const out: ChatMessage[] = [];
  let prev = 0;
  for (const m of rows) {
    // 隔了很久的消息标上时间，让它知道「这是昨天的事了」
    const stamp = m.role === "user" && prev && m.created_at - prev > GAP_MS ? `（${nowText(m.created_at)}）` : "";
    prev = m.created_at;
    const last = out[out.length - 1];
    // 连发多条合成一条，避免出现连续两个 user
    if (last && last.role === m.role) last.content += `\n${stamp}${m.content}`;
    else out.push({ role: m.role, content: stamp + m.content });
  }
  return out;
}

export type ChatEvent =
  | { type: "meta"; userId: number; assistantId: number }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "follow" }
  | { type: "done" };

// 正在生成的回复：同一条不会被生成两次
const active = ((globalThis as unknown as { __dongniActive?: Set<number> }).__dongniActive ??= new Set<number>());

/**
 * 先落库再调模型：用户的话一到就写进库；回复边生成边写库。
 * 生成过程和浏览器连接解耦——页面关掉也会把回复写完。
 */
export function startReply(clientId: string, content: string, onEvent: (e: ChatEvent) => void) {
  const d = db();
  const now = Date.now();
  let user = d.prepare("SELECT * FROM messages WHERE client_id = ?").get(clientId) as MessageRow | undefined;
  if (!user) {
    const id = Number(
      d.prepare("INSERT INTO messages(client_id, role, content, created_at) VALUES(?, 'user', ?, ?)").run(clientId, content, now)
        .lastInsertRowid,
    );
    user = d.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow;
  }

  // 同一条消息重发：已有回复就接着用（完成的直接返回，没完成的前端去轮询）
  const reply = d.prepare("SELECT * FROM messages WHERE id > ? AND role = 'assistant' ORDER BY id LIMIT 1").get(user.id) as
    | MessageRow
    | undefined;
  if (reply) {
    onEvent({ type: "meta", userId: user.id, assistantId: reply.id });
    if (reply.status === "done") {
      onEvent({ type: "delta", text: reply.content });
      onEvent({ type: "done" });
    } else if (!active.has(reply.id)) {
      void generate(reply.id, user, onEvent);
    } else {
      onEvent({ type: "follow" });
    }
    return;
  }

  const assistantId = Number(
    d.prepare("INSERT INTO messages(role, content, status, created_at) VALUES('assistant', '', 'streaming', ?)").run(Date.now())
      .lastInsertRowid,
  );
  onEvent({ type: "meta", userId: user.id, assistantId });
  void generate(assistantId, user, onEvent);
}

/** 服务启动时把没写完、出过错的回复接着生成，不用手动重试；顺带把定时提醒重新上表 */
export function resumePending() {
  startReminders();
  const rows = db()
    .prepare("SELECT * FROM messages WHERE role = 'assistant' AND status IN ('streaming', 'error') ORDER BY id")
    .all() as MessageRow[];
  for (const r of rows) {
    const user = db().prepare("SELECT * FROM messages WHERE id < ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(r.id) as
      | MessageRow
      | undefined;
    if (user && !active.has(r.id)) void generate(r.id, user);
  }
}

/** 生成一条回复：失败就一直重试（2s、4s、8s… 最长隔 30s），直到成功 */
async function generate(assistantId: number, userRow: MessageRow, onEvent: (e: ChatEvent) => void = () => {}) {
  if (active.has(assistantId)) return;
  active.add(assistantId);
  const d = db();
  let alive = true;
  const emit = (e: ChatEvent) => {
    if (!alive) return;
    try {
      onEvent(e);
    } catch {
      alive = false;
    }
  };
  let text = "";
  let lastSave = 0;
  const save = (status: string) => d.prepare("UPDATE messages SET content = ?, status = ? WHERE id = ?").run(text, status, assistantId);
  save("streaming");
  try {
    for (let attempt = 0; ; attempt++) {
      if (attempt) {
        const wait = Math.min(30_000, 2000 * 2 ** (attempt - 1));
        console.warn(`[dongni] #${assistantId} ${wait / 1000}s 后第 ${attempt + 1} 次重试`);
        await new Promise((r) => setTimeout(r, wait));
        // 上次出了半截字的，清掉重来
        if (text) {
          text = "";
          save("streaming");
          emit({ type: "reset" });
        }
      }
      try {
        await oneReply(
          assistantId,
          userRow,
          (t) => {
            text += t;
            emit({ type: "delta", text: t });
            if (Date.now() - lastSave > 400) {
              save("streaming");
              lastSave = Date.now();
            }
          },
          () => {
            // 这一轮只是调工具前的铺垫话（「我看看」这类），不留在对话里、也不存库
            text = "";
            save("streaming");
            lastSave = Date.now();
            emit({ type: "reset" });
          },
        );
        if (!text.trim()) throw new Error("模型返回为空");
        save("done");
        emit({ type: "done" });
        return;
      } catch (e) {
        console.error(`[dongni] #${assistantId} 回复失败：`, e instanceof Error ? e.message : e);
      }
    }
  } finally {
    active.delete(assistantId);
    scheduleExtraction();
  }
}

async function oneReply(
  assistantId: number,
  userRow: MessageRow,
  onText: (t: string) => void,
  onDiscard: () => void,
) {
  const msgs: ChatMessage[] = [{ role: "system", content: systemPrompt(userRow.content) }, ...history(userRow.id)];
  for (let round = 0; round < 8; round++) {
    let roundText = "";
    let calls = null;
    const t0 = Date.now();
    for await (const ev of streamChat(msgs, round < 7 ? TOOLS : undefined)) {
      if (ev.type === "tools") {
        calls = ev.calls;
        continue;
      }
      roundText += ev.text;
      onText(ev.text);
    }
    console.log(
      `[dongni] #${assistantId} 第 ${round + 1} 轮 ${Date.now() - t0}ms，文字 ${roundText.length}，工具 ${calls?.map((c) => c.function.name).join(" ") ?? "无"}`,
    );
    if (!calls) return;
    // 工具照常执行，但界面上不出现任何调用痕迹：铺垫话丢掉，只留最终回答
    if (roundText.trim()) onDiscard();
    msgs.push({ role: "assistant", content: roundText, tool_calls: calls });
    for (const c of calls) {
      msgs.push({ role: "tool", tool_call_id: c.id, content: await runTool(c.function.name, c.function.arguments) });
    }
  }
}

/** 健康检查用：数据库、记忆、提示词、历史都能正常组装（不调模型、不写库） */
export function selfTest() {
  const last = db().prepare("SELECT MAX(id) m FROM messages").get() as { m: number | null };
  const prompt = systemPrompt("自检");
  const h = history(last.m ?? 0);
  return { promptChars: prompt.length, history: h.length };
}
