import "server-only";
import { db, type MessageRow } from "./db";
import { completeJson } from "./llm";
import { stripImageMarkdown } from "./images";

/**
 * 说错的话记一笔：她哪句话后来证实是错的（「说了没做」核对抓到的、他当面反驳并且确实是她错的）。
 *
 * 为什么要记：错话一旦留在聊天记录里，下一轮她会当成自己「说过的事实」接着往下说，还会被整理进记忆，越积越深
 * （「上回报的是模型请求失败」「我没真看表」都这么来的），以前只能他手动叫我去删。
 * 现在：页面上的记录原样不动；她回看记录、整理记忆时，这句后面带着「后来证实是错的」，不会再照着说。
 */
function table() {
  db().exec(`CREATE TABLE IF NOT EXISTS wrong_said (
    message_id INTEGER NOT NULL,
    claim TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    PRIMARY KEY (message_id, claim)
  )`);
}

export function markWrong(messageId: number, claim: string, why: string) {
  const c = claim.trim().slice(0, 200);
  if (!messageId || !c) return;
  table();
  db().prepare("INSERT OR IGNORE INTO wrong_said(message_id, claim, why, at) VALUES(?, ?, ?, ?)").run(messageId, c, why.slice(0, 200), Date.now());
  console.log(`[dongni] #${messageId} 记下一句错话（${why}）：${c.slice(0, 60)}`);
}

/** 这几条消息里哪些说错了：messageId → 错的那几句 */
export function wrongNotes(ids: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!ids.length) return out;
  table();
  const rows = db()
    .prepare(`SELECT message_id, claim FROM wrong_said WHERE message_id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { message_id: number; claim: string }[];
  for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), r.claim]);
  return out;
}

/** 接在那条消息后面给她看的注 */
export const wrongSuffix = (claims: string[] | undefined) =>
  claims?.length ? `\n（这里有说错的，后来证实不对，别再照着说：${claims.map((c) => `「${c}」`).join("、")}）` : "";

/** 他像是在说她刚才那句不对（瞎说、不对、你从哪看到的……）：粗筛，命中了才去细判 */
const DISPUTE = /瞎说|胡说|乱说|乱讲|瞎编|编的|放屁|骗人|扯淡|不对|不是这样|错了|哪(儿|里)?看到|哪来的|你确定|不可能/;

/**
 * 他反驳了：看看她上一句到底是不是真说错了、错的是哪句。是就记下来。
 * 不挡回复（后台跑），判断不出来就算了——宁可漏记，不能把对的话当错的。
 */
export async function noteDispute(user: MessageRow) {
  const said = stripImageMarkdown(user.content);
  if (!DISPUTE.test(said)) return;
  const prev = db()
    .prepare("SELECT * FROM messages WHERE id < ? AND role = 'assistant' AND status = 'done' AND kind != 'system' ORDER BY id DESC LIMIT 1")
    .get(user.id) as MessageRow | undefined;
  if (!prev) return;
  try {
    const r = await completeJson<{ wrong: boolean; claim: string }>(
      [
        {
          role: "user",
          content: `她上一句说：「${stripImageMarkdown(prev.content).slice(0, 800)}」
他接着说：「${said.slice(0, 300)}」

他是在指出她上一句里有说错的事实吗（编的时间、编的结果、没做却说做了、编的名字之类）？
只是情绪、玩笑、语气上不满、或者在问问题，都不算。
如果是，把她说错的那句原话摘出来（尽量短）。只输出 JSON：{"wrong":true/false,"claim":"说错的原话"}`,
        },
      ],
      200,
      "low",
    );
    if (r?.wrong && r.claim?.trim()) markWrong(prev.id, r.claim, "他指出不对");
  } catch {}
}
