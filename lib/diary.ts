import "server-only";
import { db, type MessageRow } from "./db";
import { completeJson } from "./llm";
import { INTRO, PERSONA } from "./persona";
import { stripImageMarkdown } from "./images";

/**
 * 她自己的日记：每天一篇，写那天发生了什么、她想了什么、卡在哪。
 * 不是给他的汇报，是她自己要记得——第二天他问「昨天我说了啥」，她接得住。
 */
function table() {
  db().exec("CREATE TABLE IF NOT EXISTS diary (date TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL)");
}

const dayKey = (d: Date) => d.toLocaleDateString("sv-SE");

export function recentDiary(n = 3): { date: string; text: string }[] {
  table();
  return db().prepare("SELECT date, text FROM diary ORDER BY date DESC LIMIT ?").all(n) as { date: string; text: string }[];
}

export function diaryOf(date: string): string | null {
  table();
  return (db().prepare("SELECT text FROM diary WHERE date = ?").get(date) as { text: string } | undefined)?.text ?? null;
}

async function write(date: string, start: number, end: number) {
  const rows = db()
    .prepare("SELECT * FROM messages WHERE created_at >= ? AND created_at < ? AND status = 'done' AND kind != 'system' ORDER BY id")
    .all(start, end) as MessageRow[];
  if (!rows.length) return;
  const chat = rows.map((m) => `${m.role === "user" ? "他" : "我"}：${stripImageMarkdown(m.content).slice(0, 400)}`).join("\n").slice(-24000);
  const r = await completeJson<{ text: string }>([
    {
      role: "system",
      content: `${INTRO}\n\n${PERSONA}\n\n今天是 ${date}。睡前给自己写一篇日记（第一人称，只给自己看）：今天他跟我说了什么、发生了什么事、我心里怎么想的、哪里卡住了或做得不好、明天想记着什么。口语，像真的日记，150 到 300 字，不列清单。只输出 JSON：{"text":"..."}`,
    },
    { role: "user", content: chat },
  ]);
  if (r.text?.trim()) db().prepare("INSERT OR REPLACE INTO diary(date, text, created_at) VALUES(?, ?, ?)").run(date, r.text.trim(), Date.now());
}

/** 过了零点就把前一天（以及之前漏写的几天）补上；晚上 23 点后先写当天的草稿 */
export async function diaryTick() {
  table();
  const now = new Date();
  for (let back = 3; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const date = dayKey(d);
    const isToday = back === 0;
    if (isToday && now.getHours() < 23) continue;
    if (!isToday && diaryOf(date)) continue;
    try {
      await write(date, d.getTime(), d.getTime() + 86400_000);
    } catch (e) {
      console.warn("[dongni] 写日记失败：", e instanceof Error ? e.message : e);
    }
  }
}
