import "server-only";
import { completeJson } from "./llm";
import { extraToolNames } from "./tools";

/**
 * 说了没做的核对：她一句话说完，如果里面有「做了 / 在弄 / 停了 / 设好了 / 派出去了」这类说法，
 * 就拿这一轮真实调过的工具和后台实时状态对一遍。对不上——等于嘴上说了、其实什么都没发生——
 * 就让她当场补上：要么立刻真去调工具，要么一句话照实改口。
 *
 * 光靠提示词压不住：她最容易顺着自己的话往下编（「我这就去安排」「已经停了」），所以这里在话说完后用程序再查一遍。
 * 先用正则粗筛（绝大多数闲聊碰不到，零开销），命中了才花一次快模型去判断。
 */

/** 声称自己做了 / 正在做 / 马上做 / 停了某件要动手的事 */
const HINT = new RegExp(
  [
    "(已经|已|刚|都)(经)?(帮你)?(设|定|改|修|派|交|安排|写|存|发|停|关|取消|删|记|画|拍|跑|弄|处理|搞|提交|重启)",
    "(设|定|改|修|写|存|弄|搞|处理|安排|派|画|拍|跑|装|停|关|取消|删)(好|完|掉|上|下来)了",
    "(正在|在|还在)(弄|改|修|查|跑|画|拍|写|处理|搞|安排|派|装|看)",
    "(我|这就|马上|立刻|现在|先|等我)(去|来)?(帮你)?(弄|改|修|查|派|安排|设|画|拍|写|跑|处理|搞|停|关|取消|看看|翻翻|排查)",
    "(提醒你|叫你|喊你)(的|了)?",
    "(交给|派给|派出去|让.{0,6}去(弄|做|跑|改))",
    "(停下|停了|停掉|叫停|不弄了|取消了|关掉了)",
    "(弄完|改完|做完|跑完)(了|告诉你|跟你说|叫你)",
  ].join("|"),
);

export function maybeClaims(text: string) {
  return HINT.test(text);
}

export type Verdict = { unbacked: boolean; claim: string; fix: string };

/**
 * 判这句话里「说自己做了/在做/会做/停了」的事，有没有这一轮真实调用的工具或后台状态撑着。
 * 判不出来（超时、模型出错）就当没问题放过：核对是兜底，不能因为它把正常回复拦住。
 */
export async function checkClaims(input: { reply: string; asked: string; tools: string[]; state: string }): Promise<Verdict | null> {
  const prompt = `你在核对一个 AI 伙伴刚说的话，有没有「说了没做」：嘴上说自己做了、正在做、马上去做、已经停了某件需要真实操作的事，但实际上什么操作都没发生。

需要真实操作才算数的事（括号里是对应的工具）：设/取消提醒（set_reminder / cancel_reminder）、改自己的代码（repair_self）、派活给后台执行器（dispatch_task）、给后台的活补话（task_append）、停掉派出去的活（cancel_task）、写文件（write_file）、画图（generate_image）、拍照（take_photo）、查电脑上的文件或状态（list_dir / read_file / search_files / system_info）、换城市（set_city）、记做不到的事（note_gap）。${(() => {
    try {
      const extra = extraToolNames();
      return extra.length ? `另外她还有这些后来加的工具，调了也算真做了：${extra.join("、")}。` : "";
    } catch {
      return "";
    }
  })()}
能证明「真做了」的只有两样：这一轮真实调用过的工具（下面列出），或者后台实时状态里写着的事（比如状态里有个派出去在跑的活，说「还在跑」就是真的）。
不算问题的：
- 跟后台实时状态对得上的：报的时间、日期和状态里的准确时间一致；说某件事「在做 / 做完了 / 没做成」，状态里正好写着；
- 纯聊天、表达情绪、回忆聊过的事、给建议、讲知识、承认没做/做不了；
- 「记住了」「我记下了」（聊过的话会自动整理进记忆，这句是真的）；
- 假设、计划问句（「要不要我帮你设个提醒？」）、在说对方做的事；
- 已经被工具或状态证实的说法。

他刚才说：${input.asked.slice(0, 400)}
她这一轮真实调用过的工具：${input.tools.length ? input.tools.join("；") : "（一个都没有）"}
后台实时状态：
${input.state}

她的回复：
${input.reply.slice(0, 1500)}

只输出 JSON：{"unbacked":true/false,"claim":"没被证实的那句原话（没有就空）","fix":"她该调用的工具名，或者「改口」"}`;
  try {
    return await Promise.race([
      // 稍微想一下再判：不思考时误判多，误判会逼她认一个不存在的错，反而说出新的错话
      completeJson<Verdict>([{ role: "user", content: prompt }], 600, "low"),
      new Promise<null>((ok) => setTimeout(() => ok(null), 12_000)),
    ]);
  } catch (e) {
    console.warn(`[dongni] 说了没做的核对没跑成，放过这句：${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** 核对不过时塞给她的那句话：只给事实，让她自己选补做还是改口 */
export function correction(v: Verdict) {
  return `（系统核对：你刚才说「${v.claim.slice(0, 80)}」，但这一轮你没有真的调用工具去做，后台状态里也没有这件事——它实际上没有发生。现在二选一：能做就立刻调用对应的工具（${v.fix || "对应的工具"}）真的去做，做完再说；做不了或不该做，就用一句话自然地改口（比如「刚才说快了，其实还没弄」），并说清楚现在的真实情况。别重复刚才那句，别长篇道歉。如果后台实时状态里其实写着这件事（比如确实在做、确实做完了、时间就是这个），那刚才的话是对的——照状态如实说一句就行，不要认错、不要说自己没做。）`;
}
