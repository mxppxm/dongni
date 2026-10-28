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

const IDLE_MS = 25_000;

/**
 * 流式对话一轮。开深度思考（简单的话模型自己想得少，首字约 1 秒）。模型要用工具时，最后吐出一个 tools 事件。
 * 接口偶尔会接上了却一直不出字：25 秒没有任何数据就断开；还没出字的话自动重来，最多 3 次。
 */
export async function* streamChat(messages: ChatMessage[], tools?: unknown[]): AsyncGenerator<StreamEvent> {
  for (let attempt = 0; ; attempt++) {
    let yielded = false;
    try {
      for await (const ev of streamOnce(messages, tools)) {
        yielded = true;
        yield ev;
      }
      return;
    } catch (e) {
      if (yielded || attempt >= 2) throw e;
      console.warn(`[dongni] 模型无响应，第 ${attempt + 2} 次重试：`, (e as Error).message);
    }
  }
}

async function* streamOnce(messages: ChatMessage[], tools?: unknown[]): AsyncGenerator<StreamEvent> {
  const ctrl = new AbortController();
  let idle: NodeJS.Timeout = setTimeout(() => ctrl.abort(new Error("模型 25 秒没有响应")), IDLE_MS);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new Error("模型 25 秒没有响应")), IDLE_MS);
  };
  try {
    const res = await post(
      { messages, stream: true, reasoning_effort: process.env.DONGNI_CHAT_REASONING || "high", max_tokens: 16000, temperature: 0.8, ...(tools ? { tools } : {}) },
      ctrl.signal,
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const calls: ToolCall[] = [];
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
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
  } finally {
    clearTimeout(idle);
  }
}

/** 要 JSON 结果的后台任务（记忆整理、画像） */
export async function completeJson<T>(messages: ChatMessage[], maxTokens = 6000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await post(
        { messages, response_format: { type: "json_object" }, reasoning_effort: "low", max_tokens: maxTokens, temperature: 0.2 },
        AbortSignal.timeout(180_000),
      );
      const json = await res.json();
      const text: string = json.choices?.[0]?.message?.content ?? "";
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
