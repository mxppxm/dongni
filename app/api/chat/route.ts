import { startReply, type ChatEvent } from "@/lib/chat";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { clientId, content } = (await req.json()) as { clientId?: string; content?: string };
  if (!clientId || !content?.trim()) return Response.json({ error: "空消息" }, { status: 400 });

  const enc = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: ChatEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
          if (e.type === "done" || e.type === "follow") {
            closed = true;
            controller.close();
          }
        } catch {
          // 浏览器已断开：回复照样在后台写完
          closed = true;
        }
      };
      startReply(clientId, content.trim(), send);
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
