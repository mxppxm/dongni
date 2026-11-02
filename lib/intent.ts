import "server-only";
import { completeJson } from "./llm";

/**
 * 开口前的一眼判断：他这句是要她「做一件事」，还是聊天。
 *
 * 为什么要先判断：以前她边想边说边决定要不要动手，常常先把「画着呢」说出口、却没调工具，
 * 被「说了没做」的核对抓到再补做，补完又说一遍——同一个意思三段，前后不连贯。
 * 现在要做事的回合由代码先把工具调了，交出去之后她只开口一次。
 * 判断不出来（超时、出错）就当聊天，照原来的路子走，不耽误回话。
 */
export type Plan = { act: boolean; tool?: string };

export async function planTurn(input: { said: string; recent: string; tools: { name: string; description: string }[] }): Promise<Plan> {
  const list = input.tools.map((t) => `- ${t.name}：${t.description.slice(0, 60)}`).join("\n");
  const prompt = `判断他刚说的这句，是不是要她现在就动手做一件事（需要调用下面某个工具才能做到）。

要动手的例子：让她画图/换一张/按新要求重画、设提醒、派活、查进度、叫停、查电脑上的文件、拍照、换城市。
不算动手：聊天、问感受、问她在干嘛、评价、开玩笑、讲知识；以及只是在描述、还没要求她做的。
他在给刚才那件事补充要求（「要真丝的」「要全身的」）也算要动手，工具和刚才那件一样。

可用的工具：
${list}

最近的对话：
${input.recent}

他刚说：${input.said}

只输出 JSON：{"act":true/false,"tool":"要先调的工具名（act 为 false 时留空）"}`;
  try {
    const r = await Promise.race([
      completeJson<Plan>([{ role: "user", content: prompt }], 80, "none"),
      new Promise<null>((ok) => setTimeout(() => ok(null), 4000)),
    ]);
    if (!r?.act || !r.tool || !input.tools.some((t) => t.name === r.tool)) return { act: false };
    return { act: true, tool: r.tool };
  } catch {
    return { act: false };
  }
}
