import { deepseekBalance } from "@/lib/balance";

export const dynamic = "force-dynamic";

/** 左边任务栏顶上那行小字用的：DS 余额。取不到就回上次的数字（stale），不抛错 */
export async function GET() {
  const b = await deepseekBalance();
  return Response.json(b, { headers: { "cache-control": "no-store" } });
}
