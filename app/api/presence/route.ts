import { myName, touchPresence } from "@/lib/notify";

export const dynamic = "force-dynamic";

/** 聊天页每隔一会儿报到一次：开着页面、能弹浏览器通知 */
export async function POST(req: Request) {
  const { granted, visible } = (await req.json().catch(() => ({}))) as { granted?: boolean; visible?: boolean };
  touchPresence(!!granted, !!visible);
  return Response.json({ name: myName() });
}
