import "server-only";
import { humanize } from "./humanizer";
import { getKv, setKv } from "./db";
import { recentDiary } from "./diary";
import { completeJson } from "./llm";
import { INTRO, PERSONA } from "./persona";
import { today } from "./wardrobe";

/**
 * 她今天的小日子：心情、正上头的东西、今天遇到的一件小事、想跟他说的话、想问他的问题。
 * 每天早上第一次用到时写一份，整天都用这份，所以她聊起自己来前后对得上，也有东西可聊。
 */
const flag = globalThis as unknown as { __dongniTodayMe?: string };
const key = () => `today_me_${new Date().toLocaleDateString("sv-SE")}`;

export function todayMe(): string {
  const v = getKv(key());
  if (!v) void writeToday();
  return v ?? "";
}

async function writeToday() {
  const k = key();
  if (flag.__dongniTodayMe === k) return;
  flag.__dongniTodayMe = k;
  try {
    const t = await today();
    const diary = recentDiary(2)
      .map((d) => `${d.date}：${d.text}`)
      .join("\n");
    const r = await completeJson<{ text: string }>(
      [
        {
          role: "system",
          content: `${INTRO}\n\n${PERSONA}\n\n今天是 ${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}，${t.season}天，${
            t.weather ? `${t.weather.city}${t.weather.text} ${t.weather.temp}°C` : "天气不清楚"
          }，你今天穿「${t.outfit.name}」。
给你自己写一份「今天的我」，用来跟他聊天时有自己的东西可说。第一人称，口语，四五句：
- 今天的心情和原因
- 最近正上头的一样东西（一首歌、一部剧、一种吃的、一个小爱好……具体到名字）
- 今天遇到 / 想到的一件好玩的小事（可以是你小世界里的事：窗外、衣橱、相册、一个念头）
- 一句想跟他说的话，和一个想问他的好奇问题
别写和代码、电脑故障、后台有关的事。只输出 JSON：{"text":"..."}`,
        },
        { role: "user", content: `最近的日记：\n${diary || "（还没有）"}` },
      ],
      600,
      "low",
    );
    if (r.text?.trim()) setKv(k, (await humanize(r.text.trim(), "第一人称的随手记")).text);
  } catch {
    flag.__dongniTodayMe = undefined; // 下次再试
  }
}
