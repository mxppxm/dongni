import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 模型和 key 直接读 pi 的配置（~/.pi/agent/models.json + settings.json 里的默认模型），
 * pi 换了 key / 模型这里自动跟着换，不另外保存。
 */
const PI_DIR = path.join(os.homedir(), ".pi", "agent");

type Route = { baseUrl: string; apiKey: string; model: string };

let cache: { mtime: number; route: Route } | null = null;

function route(): Route {
  const modelsFile = path.join(PI_DIR, "models.json");
  const settingsFile = path.join(PI_DIR, "settings.json");
  const mtime = Math.max(fs.statSync(modelsFile).mtimeMs, fs.statSync(settingsFile).mtimeMs);
  if (cache && cache.mtime === mtime) return cache.route;

  const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const providerId: string = process.env.DONGNI_PROVIDER || settings.defaultProvider;
  const provider = models.providers?.[providerId];
  if (!provider) throw new Error(`pi 配置里找不到 provider：${providerId}`);
  const model: string = process.env.DONGNI_MODEL || settings.defaultModel || provider.models?.[0]?.id;
  const r = { baseUrl: String(provider.baseUrl).replace(/\/$/, ""), apiKey: provider.apiKey, model };
  cache = { mtime, route: r };
  return r;
}

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

/** 网络抖动或 5xx 时自动重试两次（还没开始出字，重试不会重复内容） */
/**
 * 跟他聊天用的模型。默认跟后台一样走 pi 的默认模型（flash，快）；
 * 试过 Kimi K3：更灵，但首字 3～18 秒，太慢，他让切回来了。想再试可以设 DONGNI_CHAT_MODEL。
 */
const CHAT_MODEL = process.env.DONGNI_CHAT_MODEL || undefined;

async function post(body: Record<string, unknown>, signal?: AbortSignal) {
  const r = route();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((ok) => setTimeout(ok, 700 * attempt));
    try {
      const res = await fetch(`${r.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${r.apiKey}` },
        body: JSON.stringify({ model: r.model, ...body }),
        signal,
      });
      if (res.ok) return res;
      const err = new Error(`模型接口 ${res.status}: ${(await res.text()).slice(0, 300)}`);
      if (res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
      lastErr = err;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export type StreamEvent = { type: "text"; text: string } | { type: "tools"; calls: ToolCall[] };

/**
 * 请求前把上下文削到最后能接上话的那一小段：首包慢，十有八九是发出去的东西太多，
 * 尤其工具结果动辄两三万字、来回几轮全堆在请求里。
 * 切点只落在 user 上——拆开 assistant 的 tool_calls 和它后面的 tool 结果，接口会直接报错。
 */
type SlimRule = { keep: number; text: number; tool: number; images: number };

const SLIM: Record<"normal" | "tight", SlimRule> = {
  normal: { keep: 20, text: 2000, tool: 6000, images: 2 },
  tight: { keep: 6, text: 400, tool: 800, images: 1 }, // 首包超时后重试用：只留最小的一段
};

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "…" : text);

function clipOne(m: ChatMessage, rule: SlimRule): ChatMessage {
  if (m.role === "tool") return { ...m, content: clip(m.content, rule.tool) };
  if (typeof m.content === "string") return { ...m, content: clip(m.content, rule.text) };
  return m;
}

export function slimMessages(messages: ChatMessage[], level: "normal" | "tight" = "normal"): ChatMessage[] {
  const rule = SLIM[level];
  const sys: ChatMessage[] = [];
  let rest = messages;
  while (rest.length && rest[0].role === "system") {
    sys.push(rest[0]);
    rest = rest.slice(1);
  }
  if (!rest.length) return messages;
  let cut = Math.max(0, rest.length - rule.keep);
  while (cut < rest.length && rest[cut].role !== "user") cut++;
  // 一长串工具来回里可能找不到干净的切点：那就原样发，总比拆坏了强
  if (cut >= rest.length) return messages;
  const kept = rest.slice(cut).map((m) => clipOne(m, rule));
  if (cut > 0) {
    // 砍掉的里面往往就有「他到底问的什么」，只留一堆工具结果模型会答偏：把最近那条 user 带回来
    for (let i = cut - 1; i >= 0; i--) {
      const prev = rest[i];
      if (prev.role !== "user") continue;
      const ask = clip(typeof prev.content === "string" ? prev.content : "（他发了图）", Math.min(rule.text, 200));
      const first = kept[0];
      kept[0] =
        typeof first.content === "string"
          ? { ...first, content: `${ask}\n${first.content}` }
          : ({ ...first, content: [{ type: "text", text: ask }, ...first.content] } as ChatMessage);
      break;
    }
  }
  let left = rule.images; // 图太占地方，只留最近几条
  for (let i = kept.length - 1; i >= 0; i--) {
    const m = kept[i];
    if (typeof m.content === "string") continue;
    const parts = m.content;
    const imgs = parts.filter((p) => p.type === "image_url");
    if (!imgs.length) continue;
    if (left >= imgs.length) {
      left -= imgs.length;
      continue;
    }
    const keep = left > 0 ? imgs.slice(-left) : [];
    left = 0;
    const text = parts.filter((p) => p.type === "text");
    const next: ContentPart[] = [...text, ...keep];
    if (!next.length) next.push({ type: "text", text: "（他发了图）" });
    kept[i] = { ...m, content: next } as ChatMessage;
  }
  return [...sys, ...kept];
}

/**
 * 超时：不是为了催模型，是为了别让连接挂着不动还一直等。
 * 分三段看，别混成一个：
 * - 首包：发出去多久一个字都没来（换模型、模型忙的时候第一句就是会慢，给到 60 秒）；
 * - 中途停顿：已经在说话了，突然没声了；
 * - 总时长：整轮最多这么久，不能无限等。
 * 每收到一段内容就重新拨钟，所以只有「真的一声不吭」才会超时。
 */
const FIRST_MS = 60_000;
const IDLE_MS = 60_000;
const TOTAL_MS = 180_000;

export type TimeoutPhase = "first" | "idle" | "total";

function timeoutError(message: string, phase: TimeoutPhase) {
  const e = new Error(message);
  e.name = "TimeoutError";
  return Object.assign(e, { phase });
}

/** 流式对话一轮。模型要用工具时，最后吐出一个 tools 事件。 */
export async function* streamChat(messages: ChatMessage[], tools?: unknown[]): AsyncGenerator<StreamEvent> {
  // 首包慢多半是网关排队、也可能是这一轮带的东西太多：一个字都还没出的时候超时了，
  // 就把上下文再砍一刀重发一次。已经出过字的不重来（重来会把同一段话说两遍）。
  let spoken = false;
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const ev of streamOnce(messages, tools, attempt ? "tight" : "normal")) {
        spoken = true;
        yield ev;
      }
      return;
    } catch (e) {
      const phase = (e as { phase?: string }).phase;
      if (attempt || spoken || phase !== "first") throw e;
      console.warn(`[dongni] 首包没来，再发一次：${(e as Error).message}`);
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
}

async function* streamOnce(
  messages: ChatMessage[],
  tools?: unknown[],
  level: "normal" | "tight" = "normal",
): AsyncGenerator<StreamEvent> {
  const ac = new AbortController();
  const started = Date.now();
  let gotFirst = false; // 模型吐过第一个字没有：决定现在算「首包超时」还是「停住了」
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    const elapsed = Date.now() - started;
    const left = TOTAL_MS - elapsed;
    if (left <= 0) {
      ac.abort(timeoutError(`模型这一轮太久没说完（超过 ${TOTAL_MS / 1000} 秒）`, "total"));
      return;
    }
    if (!gotFirst) {
      const first = FIRST_MS - elapsed;
      if (first <= 0) {
        ac.abort(timeoutError(`${Math.round(elapsed / 1000)} 秒还没等到模型开口`, "first"));
        return;
      }
      timer = setTimeout(() => ac.abort(timeoutError(`${FIRST_MS / 1000} 秒还没等到模型开口`, "first")), Math.min(first, left));
      return;
    }
    timer = setTimeout(
      () => ac.abort(timeoutError(`${IDLE_MS / 1000} 秒没等到模型的新内容`, "idle")),
      Math.min(IDLE_MS, left),
    );
  };
  try {
    arm();
    const res = await post(
      { ...(CHAT_MODEL ? { model: CHAT_MODEL } : {}), messages: slimMessages(messages, level), stream: true, reasoning_effort: process.env.DONGNI_CHAT_REASONING || "low", max_tokens: 16000, temperature: 0.85, ...(tools ? { tools } : {}) },
      ac.signal,
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const calls: ToolCall[] = [];
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gotFirst = true; // 开口了，之后按「停住了」算
      arm(); // 有动静了，闹钟往后拨
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta;
          if (delta?.content) yield { type: "text", text: delta.content as string };
          for (const tc of delta?.tool_calls ?? []) {
            const i = tc.index ?? 0;
            calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].function.name += tc.function.name;
            if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
          }
        } catch {
          // 半截行，忽略
        }
      }
    }
    const done = calls.filter(Boolean);
    if (done.length) yield { type: "tools", calls: done };
  } catch (e) {
    // 超时统一报成一句能看懂的话，日志里不再是一团 AbortError
    if (ac.signal.aborted) throw ac.signal.reason instanceof Error ? ac.signal.reason : timeoutError("模型超时", "total");
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 要 JSON 结果的后台任务（记忆整理、画像）：超时自己报清楚，不然日志里只有一句 aborted */
const JSON_MS = 180_000;

export async function completeJson<T>(messages: ChatMessage[], maxTokens = 6000, effort = "low"): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(timeoutError(`${JSON_MS / 1000} 秒没等到模型的答案`, "total")), JSON_MS);
    try {
      const res = await post(
        { messages, response_format: { type: "json_object" }, reasoning_effort: effort, max_tokens: maxTokens, temperature: 0.2 },
        ac.signal,
      );
      const json = await res.json();
      const text: string = json.choices?.[0]?.message?.content ?? "";
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
