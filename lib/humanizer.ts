import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getKv, setKv } from "./db";
import { completeJson } from "./llm";

/**
 * 去 AI 味：接的是开源的 Humanizer-zh（op7418/Humanizer-zh，MIT，原文在 vendor/humanizer-zh/）。
 *
 * 两种用法：
 * 1. 聊天回复要快，不能再过一遍模型——把它的模式清单里跟聊天相关的那些，浓缩成 CHAT_TELLS 写进她的提示词，写的时候就避开。
 * 2. 不赶时间的长一点的文字（日记、今天的小日子、她给他写的文件、他让她帮忙改的稿子）——用完整的 SKILL.md 当规则，真改一遍。
 */
const SKILL = path.join(process.cwd(), "vendor", "humanizer-zh", "SKILL.md");
let skillText: string | null = null;
const skill = () => (skillText ??= fs.readFileSync(SKILL, "utf8"));

/**
 * 改这一段用哪个模型。默认 deepseek-flash——接口明确支持的模型名。
 * 之前这里写死 kimi/kimi-k3，接口不认这个名字，每篇都是 400，改写一直在空转。
 * 想换就设 DONGNI_HUMANIZE_MODEL，但必须是接口真的支持的模型名；
 * 名字不对也不会白改：先换默认模型再试一次，还不行才降级，并且记下来。
 */
const MODEL = () => process.env.DONGNI_HUMANIZE_MODEL?.trim() || "deepseek-flash";

/** 上一次改写是什么状态（成功 / 降级），存在 kv 里，日志之外也看得到 */
const STATE_KEY = "humanize_state";

export type HumanizeState = {
  ok: boolean;
  at: number;
  /** 连续失败次数 */
  count: number;
  why?: string;
  genre?: string;
  model?: string;
};

function readState(): HumanizeState | null {
  try {
    const raw = getKv(STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as HumanizeState;
    return typeof s?.at === "number" ? s : null;
  } catch {
    return null;
  }
}

/** 现在的状态：ok=false 就是「最近一次没改成，落了原文」 */
export function humanizeState(): HumanizeState | null {
  return readState();
}

function noteOk() {
  const prev = readState();
  // 只在「从坏到好」的那一刻写一次，别每篇都写库
  if (!prev || prev.ok) return;
  try {
    setKv(STATE_KEY, JSON.stringify({ ...prev, ok: true, at: Date.now(), count: 0 } satisfies HumanizeState));
  } catch {
    // 记不下不影响改写本身
  }
  console.warn(`[dongni] 去 AI 味改写恢复了（上次失败 ${prev.count} 次，原因：${prev.why ?? "不明"}）`);
}

function noteFail(genre: string, why: string) {
  const prev = readState();
  const count = prev && !prev.ok ? prev.count + 1 : 1;
  const model = MODEL();
  try {
    setKv(STATE_KEY, JSON.stringify({ ok: false, at: Date.now(), count, why, genre, model } satisfies HumanizeState));
  } catch {
    // 记不下也照样打日志
  }
  console.error(`[dongni] 去 AI 味改写失败，这篇用的是原文（连第 ${count} 次；模型 ${model}；文体 ${genre}）：${why}`);
}

/** 从 Humanizer-zh 31 条模式里挑出聊天里最常见的，写给她自己看 */
export const CHAT_TELLS = `【别有 AI 味】（照开源的 Humanizer-zh 整理，写的时候就避开）
- 「不是 X，而是 Y」「这不仅是……更是……」这种先立个靶子再翻转的句式。
- 一句话收尾的金句、格言、伪深度（「这就是生活吧」「慢慢来，比较快」）。
- 硬凑三个并列、四字词排比、每句同一个开头。
- 破折号当万能连接，一句话里塞好几个——
- 拔高意义：「这彰显了」「意义非凡」「见证了」「至关重要」「赋能」「深度」「全方位」。
- 客服腔：「好问题！」「希望对你有帮助」「如有需要随时告诉我」。
- 反复免责：「作为 AI……」「我无法确定……」。不知道就直说一句，别绕。
- 句尾补一句总结或升华，结尾套话。
- 粗体、小标题、列表当装饰。
说话像一个具体的人：有具体的词、具体的事、具体的反应，句子长短不齐，想到哪说到哪。`;

/**
 * 按 Humanizer-zh 改一遍。只改表达，不加事实、不丢信息；改坏了（太短、空了）就用原文。
 * genre 用来告诉它文体（日记、聊天、说明文档……），它会保留那种文体该有的东西。
 *
 * degraded=true 表示「这次没改，给的是原文」——调用方不能当成改好了去说。
 */
export async function humanize(text: string, genre = "随笔"): Promise<{ text: string; degraded: boolean }> {
  const src = text.trim();
  if (src.length < 20) return { text: src, degraded: false };
  const messages = [
    {
      role: "system" as const,
      content: `${skill()}\n\n---\n你现在按上面的规则改一段文字。文体：${genre}。只输出 JSON：{"text":"改好的全文"}`,
    },
    { role: "user" as const, content: src },
  ];
  const maxTokens = Math.min(8000, src.length * 3 + 500);
  let why = "";
  // 先用配置的模型；它不被接口认（或者挂了）就用主线那台默认模型再来一次
  for (const model of [MODEL(), undefined]) {
    try {
      const r = await completeJson<{ text: string }>(messages, maxTokens, "low", model);
      const out = r.text?.trim() ?? "";
      if (out && out.length > src.length * 0.5) {
        noteOk();
        return { text: out, degraded: false };
      }
      why = out ? `改出来的太短（${out.length} 字，原文 ${src.length} 字）` : "改出来是空的";
      break; // 模型通了，只是这次结果不能用：换模型也没意义
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
  }
  noteFail(genre, why);
  return { text: src, degraded: true };
}
