import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeProfile, hasLlmConfig } from "./llmconfig";

/**
 * DS（DeepSeek）账户还剩多少钱。key 不写死：有 config/llm.json 就只看当前生效的那条线路
 * （走的不是 DS 官方——比如公司网关——就没有余额可看，off=true，页面不显示）；
 * 没有这个文件才看环境变量和 pi 配置里的 ds 供应商。都没有就当取不到，不报错。
 */
export type Balance = { amount: number | null; currency: string; at: number; stale: boolean; off?: boolean };

type Route = { baseUrl: string; apiKey: string };

const isDeepseek = (baseUrl: string) => /api\.deepseek\.com/i.test(baseUrl);

/** null = 当前线路没有余额可看 */
function route(): Route | null {
  if (hasLlmConfig()) {
    try {
      const p = activeProfile();
      const baseUrl = String(p.baseUrl ?? "").replace(/\/+$/, "");
      return p.apiKey && isDeepseek(baseUrl) ? { baseUrl, apiKey: p.apiKey } : null;
    } catch {
      return null;
    }
  }
  const env = process.env.DEEPSEEK_API_KEY?.trim();
  if (env) return { baseUrl: "https://api.deepseek.com", apiKey: env };
  try {
    const file = path.join(os.homedir(), ".pi", "agent", "models.json");
    const p = (JSON.parse(fs.readFileSync(file, "utf8")) as { providers?: Record<string, { baseUrl?: string; apiKey?: string }> })
      .providers?.ds;
    const baseUrl = String(p?.baseUrl ?? "").replace(/\/+$/, "");
    if (p?.apiKey && isDeepseek(baseUrl)) return { baseUrl, apiKey: p.apiKey };
  } catch {}
  return null;
}

/** 上一笔成功的余额留着，接口抽风时接着显示它；按 key 分开记，切了线路不会串 */
let last: { key: string; amount: number; currency: string; at: number } | null = null;
let cached: { key: string; value: Balance; at: number } | null = null;

export async function deepseekBalance(): Promise<Balance> {
  const now = Date.now();
  const r = route();
  if (!r) return { amount: null, currency: "CNY", at: now, stale: false, off: true };
  const key = r.apiKey;
  if (cached && cached.key === key && now - cached.at < 45_000) return cached.value;
  const keep = (): Balance =>
    last && last.key === key
      ? { amount: last.amount, currency: last.currency, at: last.at, stale: true }
      : { amount: null, currency: "CNY", at: 0, stale: true };

  let value: Balance;
  try {
    const res = await fetch(`${r.baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${r.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`余额接口 ${res.status}`);
    const data = (await res.json()) as { balance_infos?: { currency?: string; total_balance?: string }[] };
    const info = data.balance_infos?.find((i) => i.currency === "CNY") ?? data.balance_infos?.[0];
    const amount = Number(info?.total_balance);
    if (!Number.isFinite(amount)) throw new Error("余额接口没给数字");
    last = { key, amount, currency: info?.currency || "CNY", at: now };
    value = { amount, currency: last.currency, at: now, stale: false };
  } catch {
    value = keep();
  }
  cached = { key, value, at: now };
  return value;
}
