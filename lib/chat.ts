import "server-only";
import { CHAT_TELLS } from "./humanizer";
import { db, getKv, type MessageRow } from "./db";
import { streamChat, type ChatMessage, type ContentPart } from "./llm";
import { CAPABILITIES } from "./capabilities";
import { pickMood } from "./moods";
import { wardrobeNote } from "./wardrobe";
import { todayMe } from "./todayme";
import { recentDiary } from "./diary";
import { prepareVoice } from "./tts";
import { HONESTY, selfState } from "./selfstate";
import { addUploadedImage, getImage, imageDataUrl, imageIdsIn, imageMarkdown, stripImageMarkdown } from "./images";
import { runTool, toolsFor } from "./tools";
import { formatMemories, getProfile, nowText, relevantMemories, scheduleExtraction } from "./memory";
import { INTRO, PERSONA, SPEAKING } from "./persona";
import { attachVoiceReply, voiceIdsIn } from "./voicemsg";
import { startReminders } from "./reminders";
import { flushOutbox } from "./outbox";
import { startProgressTick } from "./progress";

const HISTORY = 40;
/**
 * 上下文只带接得上话的一部分：最近十几条给原文，更早的只留开头一句。
 * 40 条全文一起发，光历史就几千字，模型还没开口就先耗在传这些东西上（首包超时就这么来的）。
 */
const FULL_TURNS = 12;
const OLD_CHARS = 1200; // 之前是 70：再早几轮的话只剩半句，她记不住刚才聊了什么，显得不贴心
/** 单条太长的（贴了一大段代码/文章）也只带前面这一段，别把整篇塞进去 */
const MAX_TURN = 1200;
const GAP_MS = 3 * 3600_000;

/** 模型空回复最多再补两次（一共三次请求）；每次隔 300ms 左右，别让他干等 */
const EMPTY_RETRIES = 2;
const TRIES = 1 + EMPTY_RETRIES;
const RETRY_WAIT_MS = 300;
/** 兜底的那一句：短、像人话，不装作没事，也不留下空白 */
const STUCK_LINE = "卡了一下，我再来";

/** 模型这轮一个字都没说（工具跑完没接上话、回包被吞）：跟超时一样算可重试的错 */
function emptyReply() {
  return new Error("模型返回为空");
}

/** 日志里分清是首包没来、说到一半停了，还是整轮超时 */
function errText(e: unknown) {
  if (!(e instanceof Error)) return String(e);
  const phase = (e as { phase?: string }).phase;
  if (phase === "first") return `首包超时——${e.message}`;
  if (phase === "idle") return `中途停住——${e.message}`;
  if (phase === "total") return `总超时——${e.message}`;
  return e.message;
}

/**
 * 回多长：跟着他要的东西走，不按他打了几个字卡死。
 * （之前这里按他的字数定上限：他打「讲个故事吧」6 个字，她就只能回 40 字以内——故事讲成一句话，没意思。）
 */
const LENGTH_HINT = `【回多长】看他要的是什么：闲聊、接话就像发微信，自然长短；他要故事、要歌、要点子、要帮忙、要你讲讲某件事，就给足——故事要有情节和细节，歌要唱上好几句，点子要给具体的几个，不要一句话敷衍过去。`;

/** 他这次是说的，不是打字：回复得像说话——短、不分段、不列表、不代码 */
const VOICE_HINT = "【这条是语音】他刚才是用嘴说的，不是打字：回得像说话、像接话，口语，别列表、别写代码或表格。";

function systemPrompt(query: string, myself = "", voice = false) {
  const profile = getProfile();
  const mems = relevantMemories(query);
  // 顺序有讲究：先交代能做什么、对方是谁，最后才是「你是谁、怎么说话」——离回复最近的那段影响最大
  return `${INTRO}

【你能做的事】（做的过程他看不见，回复里不提工具、路径、文件名，只说结果）
- 查他这台 Mac（只读）：列文件夹、读文件、搜文件、看最近改过的文件、看电脑状态。他问到电脑、文件、最近在忙什么时就去查；没问就别翻。
- 定时提醒：他说「提醒我……」就用 set_reminder 设好（delay_seconds 是多少秒后，at 写本地时间如 2025-11-01 21:30）；查看、取消用 list_reminders / cancel_reminder。时间必须是将来。
- 改你自己（这个聊天应用的代码）：他明确让你改功能、修毛病、改样子时用 repair_self，把要求写具体。工具说暂停或排队，就照实告诉他。
${CAPABILITIES}
- 回复按 Markdown 显示：代码放代码块，命令、路径用反引号。

- 衣橱和相册：你有几套固定的衣服，穿哪套跟着时间、季节、天气自动换；相册按天攒着你自己的照片，以前的日子一张都不会被盖掉，能按日期翻回去看。他想看你今天的样子、让你拍张照时用 take_photo（会先自动跟他说一声再拍）。天气默认按北京查，他说自己在别处就用 set_city 记下。

【你自己今天】
${myself || "（不清楚）"}
${todayMe() ? `\n【今天的你】（你的小日子，聊天时可以自然地拿出来分享）\n${todayMe()}` : ""}

【你最近的日记】（你自己写的，用来记得前几天的事）
${recentDiary(3).map((d) => `${d.date}：${d.text}`).join("\n") || "（还没写过）"}

【他是什么样的人】
${profile || "（刚认识，还没形成印象）"}

【你记得的关于他的事】（#编号是内部标记，不要说出来）
${formatMemories(mems) || "（还没有）"}

${PERSONA}

现在是：${nowText()}

${SPEAKING}

${CHAT_TELLS}

${LENGTH_HINT}
${voice ? `\n${VOICE_HINT}` : ""}
【不是汇报】不复述他给的事、不排期、不报进度，不说「第一件」「接下来」「排在」「下一步」。开口第一句先接住他那句话的情绪或细节；结果只说好了 / 还差什么 / 卡住了。`;
}

const IMAGE_TURNS = 2; // 只把最近两条带图的消息真的发图给模型，更早的只留「[图片]」

function imageParts(ids: number[]): ContentPart[] {
  return ids.flatMap((id) => {
    const rec = getImage(id);
    const url = rec && imageDataUrl(rec);
    return url ? [{ type: "image_url" as const, image_url: { url } }] : [];
  });
}

/** 她上一条发给他的图：让她看得见自己发了什么，他说「这不是你啊」时她才知道在说哪张 */
function lastSentImages(userId: number): ChatMessage[] {
  const prev = db()
    .prepare("SELECT * FROM messages WHERE id < ? AND role = 'assistant' AND status = 'done' ORDER BY id DESC LIMIT 1")
    .get(userId) as MessageRow | undefined;
  const ids = prev ? imageIdsIn(prev.content) : [];
  if (!ids.length) return [];
  const parts = imageParts(ids.slice(0, 3));
  if (!parts.length) return [];
  return [{ role: "user", content: [{ type: "text", text: "（这是你上一条发给他的图，只给你自己看，方便你知道他在说哪张）" }, ...parts] }];
}

function history(beforeOrAtId: number): ChatMessage[] {
  const rows = (
    db()
      .prepare(
        "SELECT * FROM messages WHERE id <= ? AND id >= ? AND (status = 'done' OR role = 'user') AND kind != 'system' ORDER BY id DESC LIMIT ?",
      )
      // context_from：从这条往后才算她「刚才聊的」。之前一段聊乱了（画不了、我瞎说…），翻篇后她不再被那些话带着走；
      // 长期的事在记忆、画像、日记里，不会丢
      .all(beforeOrAtId, Number(getKv("context_from") ?? 0), HISTORY) as MessageRow[]
  ).reverse();
  const withImages = new Set(
    rows
      .filter((m) => m.role === "user" && imageIdsIn(m.content).length)
      .slice(-IMAGE_TURNS)
      .map((m) => m.id),
  );
  const out: { role: "user" | "assistant"; text: string; images: number[] }[] = [];
  let prev = 0;
  const recentFrom = rows.length - FULL_TURNS;
  for (const [i, m] of rows.entries()) {
    // 隔了很久的消息标上时间，让它知道「这是昨天的事了」
    const stamp = m.role === "user" && prev && m.created_at - prev > GAP_MS ? `（${nowText(m.created_at)}）` : "";
    prev = m.created_at;
    const ids = imageIdsIn(m.content);
    const send = m.role === "user" && withImages.has(m.id) ? ids : [];
    let body = stripImageMarkdown(m.content);
    const limit = i < recentFrom ? OLD_CHARS : MAX_TURN;
    if (body.length > limit) body = body.slice(0, limit) + "…";
    const text = stamp + body + (ids.length && !send.length && m.role === "user" ? "（他发了图）" : "");
    const last = out[out.length - 1];
    // 连发多条合成一条，避免出现连续两个 user
    if (last && last.role === m.role) {
      last.text += `\n${text}`;
      last.images.push(...send);
    } else out.push({ role: m.role, text, images: [...send] });
  }
  return out.map((m) =>
    m.role === "user" && m.images.length
      ? { role: "user", content: [{ type: "text", text: m.text || "（发了图片）" }, ...imageParts(m.images)] }
      : { role: m.role, content: m.text },
  );
}

export type ChatEvent =
  | { type: "meta"; userId: number; assistantId: number }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "mood"; mood: string }
  | { type: "voice"; markdown: string }
  | { type: "follow" }
  | { type: "done" };

// 正在生成的回复：同一条不会被生成两次
const active = ((globalThis as unknown as { __dongniActive?: Set<number> }).__dongniActive ??= new Set<number>());

/**
 * 先落库再调模型：用户的话一到就写进库；回复边生成边写库。
 * 生成过程和浏览器连接解耦——页面关掉也会把回复写完。
 */
export function startReply(clientId: string, content: string, onEvent: (e: ChatEvent) => void, images: string[] = []) {
  const d = db();
  const now = Date.now();
  let user = d.prepare("SELECT * FROM messages WHERE client_id = ?").get(clientId) as MessageRow | undefined;
  if (!user) {
    // 发来的图先落盘，正文里只留引用
    const refs = images.flatMap((u) => {
      const rec = addUploadedImage(u);
      return rec ? [imageMarkdown(rec.id)] : [];
    });
    const full = [content, refs.join("\n")].filter(Boolean).join("\n\n");
    const id = Number(
      d.prepare("INSERT INTO messages(client_id, role, content, created_at) VALUES(?, 'user', ?, ?)").run(clientId, full, now)
        .lastInsertRowid,
    );
    user = d.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow;
  }

  // 同一条消息重发：已有回复就接着用（完成的直接返回，没完成的前端去轮询）
  const reply = d.prepare("SELECT * FROM messages WHERE id > ? AND role = 'assistant' ORDER BY id LIMIT 1").get(user.id) as
    | MessageRow
    | undefined;
  if (reply) {
    onEvent({ type: "meta", userId: user.id, assistantId: reply.id });
    if (reply.status === "done") {
      onEvent({ type: "delta", text: reply.content });
      onEvent({ type: "done" });
    } else if (!active.has(reply.id)) {
      void generate(reply.id, user, onEvent);
    } else {
      onEvent({ type: "follow" });
    }
    return;
  }

  const assistantId = Number(
    d.prepare("INSERT INTO messages(role, content, status, created_at) VALUES('assistant', '', 'streaming', ?)").run(Date.now())
      .lastInsertRowid,
  );
  onEvent({ type: "meta", userId: user.id, assistantId });
  void generate(assistantId, user, onEvent);
}

/** 服务启动时把没写完、出过错的回复接着生成，不用手动重试；顺带把定时提醒重新上表 */
export function resumePending() {
  startReminders();
  // 上次没送进对话的那句话补一次；改自己的时候每两三分钟贴一句进度（都不依赖下面这些轮次）
  flushOutbox();
  startProgressTick();
  const rows = db()
    .prepare("SELECT * FROM messages WHERE role = 'assistant' AND status IN ('streaming', 'error') ORDER BY id")
    .all() as MessageRow[];
  for (const r of rows) {
    const user = db().prepare("SELECT * FROM messages WHERE id < ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(r.id) as
      | MessageRow
      | undefined;
    if (user && !active.has(r.id)) void generate(r.id, user);
  }
}

/** 生成一条回复：失败就再试一次，两次都不成就说一句短的，不让他对着空白干等 */
async function generate(assistantId: number, userRow: MessageRow, onEvent: (e: ChatEvent) => void = () => {}) {
  if (active.has(assistantId)) return;
  active.add(assistantId);
  const d = db();
  let alive = true;
  const emit = (e: ChatEvent) => {
    if (!alive) return;
    try {
      onEvent(e);
    } catch {
      alive = false;
    }
  };
  let text = "";
  let lastSave = 0;
  // 写库偶尔会撞锁：记一笔继续，不能因为存不进去就把这句回复也丢了
  const save = (status: string) => {
    try {
      d.prepare("UPDATE messages SET content = ?, status = ? WHERE id = ?").run(text, status, assistantId);
    } catch (e) {
      console.error(`[dongni] #${assistantId} 写库失败：`, errText(e));
    }
  };
  // 收尾只做一次：几次都没接上话、或者半路出了别的岔子，最后都落到这一句上，绝不留白
  let finished = false;
  const finishStuck = () => {
    if (finished) return;
    finished = true;
    console.warn(`[dongni] #${assistantId} 几次都没接上话，用兜底那一句接住`);
    text = STUCK_LINE;
    emit({ type: "reset" }); // 上一次留下的半截话清掉，别和这句拼在一起
    save("done");
    emit({ type: "delta", text });
    emit({ type: "done" });
  };
  let working = false; // 已经去跑腿/画画了，挑出来的心情就别盖掉它
  let worked = false; // 这轮真的跑过腿/画过图：重试时不再跑一通，免得重复发提醒、重复画画
  try {
    save("streaming");
    // 一边想怎么回，一边看对方这句话挑一个等待的样子（很快，不耽误回复）
    const recent = history(userRow.id)
      .slice(-5, -1)
      .map((m) => `${m.role === "user" ? "他" : "你"}：${typeof m.content === "string" ? m.content.slice(0, 200) : "[图片]"}`)
      .join("\n");
    void pickMood(stripImageMarkdown(userRow.content) || "[发了一张图]", recent).then((mood) => {
      if (!text && !working) emit({ type: "mood", mood });
    });
    for (let attempt = 0; attempt < TRIES; attempt++) {
      if (attempt) {
        console.warn(`[dongni] #${assistantId} 没接上话，${RETRY_WAIT_MS}ms 后第 ${attempt + 1} 次尝试`);
        await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
        // 上次出了半截字的，清掉重来
        if (text) {
          text = "";
          save("streaming");
          emit({ type: "reset" });
        }
      }
      try {
        await oneReply(
          assistantId,
          userRow,
          (t) => {
            text += t;
            emit({ type: "delta", text: t });
            if (Date.now() - lastSave > 400) {
              save("streaming");
              lastSave = Date.now();
            }
          },
          () => {
            // 这一轮只是调工具前的铺垫话（「我看看」这类），不留在对话里、也不存库
            text = "";
            save("streaming");
            lastSave = Date.now();
            emit({ type: "reset" });
          },
          (mood) => {
            working = true;
            worked = true;
            emit({ type: "mood", mood });
          },
          // 前面已经动过手了：重试只管把话说出来，不再重复跑腿
          !attempt || !worked,
        );
        // 空回复跟超时一样是可重试的错，不当作「答完了」
        // 模型自己编的图片链接（不是真画出来的）去掉，只留工具挂上的真图
        text = text.replace(/!\[[^\]]*\]\((?!\/api\/(?:image|mood|wardrobe|voice)\/)[^)]*\)\s*/g, "");
        if (!text.trim()) throw emptyReply();
        // 他刚发的是语音：她的回复也做一条语音消息接在后头。先做好再置 done，
        // 这样页面断线后轮询拿到的也是带语音的完整内容（合成慢就慢一点，文字已经在屏幕上了）
        if (voiceIdsIn(userRow.content).length) {
          try {
            const v = await attachVoiceReply(assistantId, text);
            if (v) {
              text = v.content;
              emit({ type: "voice", markdown: v.markdown });
            }
          } catch (e) {
            console.warn(`[dongni] #${assistantId} 语音回复没做出来：`, errText(e));
          }
        }
        save("done");
        finished = true;
        emit({ type: "done" });
        // 回复一写完就开始准备声音：页面来要时多半已经在合成了
        if (!text.includes("/api/voice/clip/")) prepareVoice(assistantId, text);
        return;
      } catch (e) {
        // 空回复不是坏了，只是这一轮没接上话：单独记一笔，别混进「失败」里
        if ((e as { message?: string }).message === "模型返回为空") {
          console.warn(`[dongni] #${assistantId} 第 ${attempt + 1} 次没接上话（空回复），准备再来`);
        } else {
          console.error(`[dongni] #${assistantId} 第 ${attempt + 1} 次回复失败：`, errText(e));
        }
        // key 失效、权限这类错，再试也一样，直接给他一句
        if ((e as { fatal?: boolean }).fatal) break;
      }
    }
    finishStuck();
  } catch (e) {
    // 连这一轮怎么回都没准备好（读画像、挑心情、写库这类出错）：也不能让对话留白
    console.error(`[dongni] #${assistantId} 这一轮没跑起来：`, errText(e));
    finishStuck();
  } finally {
    active.delete(assistantId);
    scheduleExtraction();
  }
}

async function oneReply(
  assistantId: number,
  userRow: MessageRow,
  onText: (t: string) => void,
  onDiscard: () => void,
  onMood: (mood: string) => void,
  allowTools = true,
) {
  const myself = await Promise.race([wardrobeNote().catch(() => ""), new Promise<string>((ok) => setTimeout(() => ok(""), 900))]);
  const msgs: ChatMessage[] = [
    { role: "system", content: systemPrompt(stripImageMarkdown(userRow.content), myself, voiceIdsIn(userRow.content).length > 0) },
    ...history(userRow.id),
    ...lastSentImages(userRow.id),
    // 放在最后、紧挨着回复：她最容易顺着自己前面说过的话往下编，这里拿真实状态压住
    {
      role: "system",
      content: `【你后台的事·实时状态】\n${selfState()}\n\n${HONESTY}\n如果你前面说过的话和这份状态对不上，用一句话轻轻纠正就行（比如「刚才说错了，其实没在弄」），然后正常聊天。认过的错不要每句都翻出来再认一遍，也别自我检讨、别说「我没瞎说」这种话——他要的是你好好说话，不是一直道歉。`,
    },
  ];
  const toolList = allowTools ? toolsFor(stripImageMarkdown(userRow.content)) : [];
  const attachments: string[] = [];
  const ctx = {
    turnId: String(assistantId),
    attach: (md: string) => attachments.push(md),
    see: (id: number) => seen.push(id),
  };
  let seen: number[] = [];
  // 回复写完后，把工具挂上的图片、卡片接在末尾
  const flush = () => {
    if (attachments.length) onText(`\n\n${attachments.splice(0).join("\n\n")}`);
  };
  const ROUNDS = 8;
  let usedTool = false; // 这次真动过手：只有动过手，最后那句「别动手了，直接说」才有意义
  for (let round = 0; round < ROUNDS; round++) {
    let roundText = "";
    let calls = null;
    const t0 = Date.now();
    for await (const ev of streamChat(msgs, allowTools && round < ROUNDS - 1 && toolList.length ? toolList : undefined)) {
      if (ev.type === "tools") {
        calls = ev.calls;
        continue;
      }
      roundText += ev.text;
      onText(ev.text);
    }
    console.log(
      `[dongni] #${assistantId} 第 ${round + 1} 轮 ${Date.now() - t0}ms，文字 ${roundText.length}，工具 ${calls?.map((c) => c.function.name).join(" ") ?? "无"}`,
    );
    if (!calls) return flush();
    usedTool = true;
    // 工具照常执行，但界面上不出现任何调用痕迹：铺垫话丢掉，只留最终回答
    // 画图、拍照要等一分钟：调用前说的那句「我给你画…」留着，算是先跟他说一声；其他工具前的铺垫话照旧丢掉
    const slow = calls.some((c) => ["generate_image", "take_photo", "create_mood"].includes(c.function.name));
    if (roundText.trim() && !slow) onDiscard();
    else if (roundText.trim()) onText("\n\n");
    msgs.push({ role: "assistant", content: roundText, tool_calls: calls });
    // 去干活了：画图就「画画」，其他都是「跑腿」
    onMood(calls.some((c) => c.function.name === "generate_image") ? "draw" : "run");
    for (const c of calls) {
      msgs.push({ role: "tool", tool_call_id: c.id, content: await runTool(c.function.name, c.function.arguments, ctx) });
    }
    // 工具打开的图片：作为一条附图消息让模型看到
    if (seen.length) {
      const parts = imageParts(seen);
      seen = [];
      if (parts.length) msgs.push({ role: "user", content: [{ type: "text", text: "（这是你刚刚打开的图片，只有你看得到）" }, ...parts] });
    }
  }
  // 一整轮都在翻东西、始终没张嘴（日志里连着好几轮「文字 0」就是这样）：最后不给工具，
  // 让它就着已经拿到的结果把话说出来。这是空回复的正根儿——光靠整轮重来，前面查到的还全丢了。
  if (usedTool) {
    msgs.push({ role: "user", content: "（别再动手查了，就着上面拿到的，用一两句话直接回我。）" });
    let roundText = "";
    const t0 = Date.now();
    for await (const ev of streamChat(msgs, undefined)) {
      if (ev.type === "tools") continue;
      roundText += ev.text;
      onText(ev.text);
    }
    console.log(`[dongni] #${assistantId} 收尾一轮 ${Date.now() - t0}ms，文字 ${roundText.length}，工具 无`);
  }
  flush();
}

/** 健康检查用：数据库、记忆、提示词、历史都能正常组装（不调模型、不写库） */
export function selfTest() {
  const last = db().prepare("SELECT MAX(id) m FROM messages").get() as { m: number | null };
  const prompt = systemPrompt("自检");
  const h = history(last.m ?? 0);
  return { promptChars: prompt.length, history: h.length };
}
