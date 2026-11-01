import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LLM_CONFIG } from "./portable";

/**
 * DS（DeepSeek）账户还剩多少钱。key 不写死：先看环境变量，再看项目配置 config/llm.json，
 * 最后看 pi 配置里的 ds 供应商。都没有就当取不到，不报错。
 */
export type Balance = { amount: number | null; currency: string; at: number; stale: boolean };

type Route = { baseUrl: string; apiKey: string };

function route(): Route | null {
  const env = process.env.DEEPSEEK_API_KEY?.trim();
  if (env) return { baseUrl: "https://api.deepseek.com", apiKey: env };
  try {
    if (fs.existsSync(LLM_CONFIG)) {
      const c = JSON.parse(fs.readFileSync(LLM_CONFIG, "utf8")) as { baseUrl?: string; apiKey?: string };
      const baseUrl = String(c.baseUrl ?? "").replace(/\/+$/, "");
      if (c.apiKey && /deepseek/i.test(baseUrl)) return { baseUrl, apiKey: c.apiKey };
    }
  } catch {}
  try {
    const file = path.join(os.homedir(), ".pi", "agent", "models.json");
    const p = (JSON.parse(fs.readFileSync(file, "utf8")) as { providers?: Record<string, { baseUrl?: string; apiKey?: string }> })
      .providers?.ds;
    const baseUrl = String(p?.baseUrl ?? "").replace(/\/+$/, "");
    if (p?.apiKey && /deepseek/i.test(baseUrl)) return { baseUrl, apiKey: p.apiKey };
  } catch {}
  return null;
}

/** 上一笔成功的余额留着，接口抽风时接着显示它 */
let last: { amount: number; currency: string; at: number } | null = null;
let cached: { value: Balance; at: number } | null = null;

export async function deepseekBalance(): Promise<Balance> {
  const now = Date.now();
  if (cached && now - cached.at < 45_000) return cached.value;
  const keep = (): Balance => (last ? { ...last, stale: true } : { amount: null, currency: "CNY", at: 0, stale: true });

  const r = route();
  let value: Balance = keep();
  if (r) {
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
      last = { amount, currency: info?.currency || "CNY", at: now };
      value = { ...last, stale: false };
    } catch {
      value = keep();
    }
  }
  cached = { value, at: now };
  return value;
}
