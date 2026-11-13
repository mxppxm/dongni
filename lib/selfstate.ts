import "server-only";
import { db } from "./db";
import { nowText } from "./memory";
import { diaryOf } from "./diary";
import { imagegenStatus } from "./imagegen";
import { moodGenerating } from "./moods";
import { pendingReminders } from "./reminders";
import { repairStatus } from "./selfrepair";
import { listDispatches } from "./superagent";
import { taskStateLines } from "./tasks";
import { photoState } from "./wardrobe";
import { voiceReady } from "./voiceconfig";
import { extraStateLines } from "./tools";

/**
 * 她后台那些事的真实状态。她说「我在做 / 我做了」之前，以这里为准——
 * 她自己看不到后台，不给她这份，她就只能顺着自己说过的话往下编。
 */
export function selfState(): string {
  // 准确时间放在最前面、离回复最近：以前只写在长长的系统提示中间，电话里不思考直接答，就顺口编了个「十点二十五」
  const lines: string[] = [`现在的准确时间：${nowText()}（他问时间、日期就照这个说——这就是你看到的钟，不用再「去看」）。`];
  lines.push(taskStateLines());
  lines.push(repairStatus());
  const jobs = listDispatches();
  lines.push(
    jobs.length
      ? `派出去的活：${jobs.map((j) => `#${j.id}「${j.title.slice(0, 24)}」${j.stageText}，${j.backend === "dsh" ? "DS superagent 在干" : j.backend === "builtin" ? "内置执行器在干" : "还没人接"}（${Math.max(1, Math.round((Date.now() - j.startedAt) / 60000))} 分钟了${j.live ? `；真实动静：${j.live}` : ""}）`).join("；")}。他问进度、问是不是卡住了，就照「真实动静」说。`
      : "现在没有派出去在跑的活。",
  );
  // 这几条是事实，他问起来照这个说，别自己猜
  lines.push(
    "后台是怎么干活的（他问才说）：派出去的活交给他本机的 DS superagent（DeepSeek Harness 上那个）干，它不在线才用内置执行器；派出去的活可以同时跑好几件，互不排队。改你自己的代码也是 superagent 来改，但一次只改一件，改完要重启。加衣服（add_outfit）不改代码、不重启。",
  );
  lines.push(imagegenStatus());
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
  try {
    const extra = extraStateLines();
    if (extra) lines.push(extra);
  } catch {}
  return lines.join("\n");
}

export const HONESTY = `上面是你后台事情的真实状态。你说自己「做了 / 正在做 / 做到哪了」，必须和这里对得上，或者是你这一轮真的调用工具拿到了结果。对不上就照实说「没在弄」「还没做」。想做就真的去调工具，光嘴上说「我去看看 / 我这就弄」等于没做。`;
