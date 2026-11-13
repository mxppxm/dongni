import { runPluginTool, type PluginView } from "@/lib/plugins";
import { listPluginsForPage } from "@/lib/tools";
import { getCity } from "@/lib/wardrobe";

export const dynamic = "force-dynamic";

/** 她平时用的城市：右上角「查天气」点开时默认查这个 */
export async function GET() {
  return Response.json({ city: getCity() });
}

/** 用「查天气」这件本事查一个城市，结果原样给页面上的小窗 */
export async function POST(req: Request) {
  const { city } = (await req.json().catch(() => ({}))) as { city?: string };
  const name = String(city ?? "").trim() || getCity();

  // 刚重启的时候插件还在试跑：等它一会儿，别一进来就说用不了
  let view: PluginView | undefined = listPluginsForPage().find((p) => p.id === "weather");
  if (!view) return Response.json({ error: "还没装「查天气」这件本事" }, { status: 404 });
  for (let i = 0; i < 20 && view.status === "probing"; i++) {
    await new Promise((r) => setTimeout(r, 400));
    view = listPluginsForPage().find((p) => p.id === "weather") ?? view;
  }
  if (view.status !== "enabled") {
    return Response.json({ error: `「查天气」现在用不了（${view.statusText}${view.why ? `：${view.why}` : ""}）` }, { status: 503 });
  }

  let card: { title: string; rows: [string, string][] } | null = null;
  const out = await runPluginTool("get_weather", JSON.stringify({ city: name }), (md) => {
    const hit = md.match(/```card\n([\s\S]*?)\n```/);
    if (!hit) return;
    try {
      const spec = JSON.parse(hit[1]) as { title?: unknown; rows?: unknown };
      const rows = Array.isArray(spec.rows)
        ? spec.rows.filter((r): r is unknown[] => Array.isArray(r) && r.length >= 2).slice(0, 12).map((r): [string, string] => [String(r[0]), String(r[1])])
        : [];
      card = { title: typeof spec.title === "string" && spec.title.trim() ? spec.title.trim() : "查天气", rows };
    } catch {}
  });
  if (out === null) return Response.json({ error: "还没装「查天气」这件本事" }, { status: 404 });
  if (out.startsWith("出错了")) return Response.json({ error: out.replace(/^出错了：/, "").trim() }, { status: 502 });
  if (!card) return Response.json({ error: "查到了，但结果没能显示出来" }, { status: 502 });
  return Response.json({ city: name, card });
}
