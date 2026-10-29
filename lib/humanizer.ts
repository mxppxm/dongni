import "server-only";
import fs from "node:fs";
import path from "node:path";
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
 */
export async function humanize(text: string, genre = "随笔"): Promise<string> {
  const src = text.trim();
  if (src.length < 20) return src;
  try {
    const r = await completeJson<{ text: string }>(
      [
        {
          role: "system",
          content: `${skill()}\n\n---\n你现在按上面的规则改一段文字。文体：${genre}。只输出 JSON：{"text":"改好的全文"}`,
        },
        { role: "user", content: src },
      ],
      Math.min(8000, src.length * 3 + 500),
      "low",
      // 这一步不赶时间，用写得更好的 Kimi K3（flash 改完常常还留着「不只是……」这种句式）
      process.env.DONGNI_HUMANIZE_MODEL || "kimi/kimi-k3",
    );
    const out = r.text?.trim() ?? "";
    return out && out.length > src.length * 0.5 ? out : src;
  } catch (e) {
    console.warn("[dongni] 去 AI 味没改成，用原文：", e instanceof Error ? e.message : e);
    return src;
  }
}
