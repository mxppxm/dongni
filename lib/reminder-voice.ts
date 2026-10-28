import "server-only";
import { streamChat } from "./llm";
import { nowText } from "./memory";
import { PERSONA, SPEAKING } from "./persona";

/**
 * 提醒到点了：把当初设的提醒内容交给模型，用她自己的口吻说一句短的，
 * 而不是硬邦邦地复述原句。模型失败、超时、说跑偏了，一律退回原始内容——提醒不能丢。
 */
const TIMEOUT_MS = 20_000;
const MAX_CHARS = 120;

function prompt(raw: string) {
  return `${PERSONA}

${SPEAKING}

现在是 ${nowText()}，之前对方让你这个点提醒他一下。请用你自己的口吻提醒一句，就像你正好想起来、顺口喊他一声。
- 一两句话，越短越好，别超过 25 个字；说完就停，不追问、不解释、不再叮嘱一遍。
- 原来的意思一个字都不能变：时间、地点、事情、数字都照原样，不要加原话里没有的内容，也不要自己补充理由。
- 原话本身就是一句能直接说的话，就照着说，最多调一下语气，别硬改、别为了活泼加戏。
- 直接说要说的话，不要加任何前缀、标签、引号，也不要加时钟图标。`;
}

/** 始终返回一句可以显示的话：要么是模型改写的，要么是原话 */
export async function speakReminder(text: string): Promise<string> {
  const raw = text.trim();
  if (!raw) return raw;
  try {
    const said = await Promise.race([
      generate(raw),
      new Promise<null>((ok) => setTimeout(() => ok(null), TIMEOUT_MS)),
    ]);
    return said || raw;
  } catch (e) {
    console.warn("[dongni] 提醒来不及改写，直接说原话：", e instanceof Error ? e.message : e);
    return raw;
  }
}

async function generate(raw: string) {
  let out = "";
  for await (const ev of streamChat([
    { role: "system", content: prompt(raw) },
    { role: "user", content: `提醒内容：${raw}` },
  ])) {
    if (ev.type === "text") out += ev.text;
  }
  return clean(out, raw);
}

/** 只取第一行、剥掉模型可能加的前缀和引号；太长或空的当成没改好 */
function clean(text: string, raw: string) {
  const line = text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)[0];
  const said = (line ?? "")
    .replace(/^⏰\s*/u, "")
    .replace(/^提醒你[:：，,]?\s*/, "")
    .replace(/^「([\s\S]*)」$/, "$1")
    .replace(/^"([\s\S]*)"$/, "$1")
    .trim();
  if (!said || said.length > MAX_CHARS) return raw;
  return said;
}