import "server-only";
import { db } from "./db";
import { diaryOf } from "./diary";
import { moodGenerating } from "./moods";
import { pendingReminders } from "./reminders";
import { repairStatus } from "./selfrepair";
import { photoState } from "./wardrobe";
import { voiceReady } from "./voiceconfig";

/**
 * 她后台那些事的真实状态。她说「我在做 / 我做了」之前，以这里为准——
 * 她自己看不到后台，不给她这份，她就只能顺着自己说过的话往下编。
 */
export function selfState(): string {
  const lines: string[] = [];
  lines.push(repairStatus());
  const mood = moodGenerating();
  lines.push(mood ? `正在给自己画新样子「${mood}」。` : "没有在画新样子。");
  try {
    lines.push(photoState() + "。");
  } catch {}
  const date = new Date().toLocaleDateString("sv-SE");
  lines.push(diaryOf(date) ? "今天的日记已经写了。" : "今天的日记还没写（每晚 23 点后自动写）。");
  const rs = pendingReminders();
  lines.push(rs.length ? `有 ${rs.length} 个提醒等着到点：${rs.slice(0, 3).map((r) => `「${r.text}」`).join("、")}。` : "没有待到点的提醒。");
  const n = (db().prepare("SELECT COUNT(*) n FROM memories WHERE status = 'active'").get() as { n: number }).n;
  lines.push(`关于他你记下了 ${n} 件事；聊过的话会在聊完几秒后自动整理进记忆，所以可以说「记住了」，但别说你把它「写进」了什么地方。`);
  try {
    lines.push(voiceReady().configured ? "声音（豆包语音）已经接上了：能发语音、也能听懂他发的语音。" : "声音（豆包语音）还没接上：缺 APP ID / Access Token（或新版控制台的 API Key），要说实话，别装作能听会说。");
  } catch {}
  return lines.join("\n");
}

export const HONESTY = `上面是你后台事情的真实状态。你说自己「做了 / 正在做 / 做到哪了」，必须和这里对得上，或者是你这一轮真的调用工具拿到了结果。对不上就照实说「没在弄」「还没做」。想做就真的去调工具，光嘴上说「我去看看 / 我这就弄」等于没做。`;
