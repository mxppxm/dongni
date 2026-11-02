import "server-only";
import { completeJson } from "./llm";

/**
 * 通话里的判断层：他每说完一句（或几句），先在这里过一下，再决定接下来干什么。
 *
 * 以前这些判断散在各处：挂电话看触发词正则、说完没看固定停顿、杂音靠一张字表、
 * 要不要提后台的事全塞进提示词——彼此不知道对方，补一处坏一处（抢话、说了挂不挂、每句都提任务）。
 * 现在统一在这里判断一次，输出结构化的决定，由 callqwen.ts 照着执行。
 *
 * 用公司网关的快模型、不思考、只出一小段 JSON（零点几秒）。判断不出来就退回最保守的默认：当他说完了、照常回。
 */
export type TurnIntent = "chat" | "ask_status" | "request" | "amend" | "stop_talking" | "end_call" | "noise";
export type TurnJudgement = { complete: boolean; intent: TurnIntent };

const INTENTS: TurnIntent[] = ["chat", "ask_status", "request", "amend", "stop_talking", "end_call", "noise"];

export async function judgeTurn(input: { heard: string; herLast: string; recent: string; tasks: string }): Promise<TurnJudgement | null> {
  const prompt = `你在帮一个语音助手判断电话里对方刚说的话。只做判断，不回答。

最近的对话：
${input.recent || "（刚开始）"}

她刚才说到：${input.herLast || "（还没说话）"}
后台的事：${input.tasks || "（没有）"}

对方刚说（语音识别出来的，可能不完整）：「${input.heard}」

判断两件事：
1. complete：他这个意思说完了吗？话说一半、明显还要接着说（比如「我想让你……」「还有就是」「然后」结尾、句子不完整）就是 false；一句完整的话、问题、要求就是 true。拿不准就 true。
2. intent，选一个：
- chat：聊天、回应、感慨、问她自己的事
- ask_status：问刚才那件事（画图、派的活、提醒…）怎么样了、好了没
- request：让她去做一件事（画、查、设提醒、派活、叫停某件活…）
- amend：给刚才那件事补充或改要求（「要真丝的」「换成全身」）
- stop_talking：让她别说了、停一下、安静
- end_call：要结束这通电话（拜拜、先这样、我去睡了、你先挂吧、挂了吧……）。只是在聊「挂电话」这个话题、问问题的不算
- noise：不是在跟她说话（自言自语、跟别人说话、读屏、无意义的声音）

只输出 JSON：{"complete":true/false,"intent":"..."}`;
  try {
    const r = await Promise.race([
      completeJson<TurnJudgement>([{ role: "user", content: prompt }], 60, "none"),
      new Promise<null>((ok) => setTimeout(() => ok(null), 2500)),
    ]);
    if (!r || !INTENTS.includes(r.intent)) return null;
    return { complete: r.complete !== false, intent: r.intent };
  } catch {
    return null;
  }
}
