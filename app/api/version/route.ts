export const dynamic = "force-dynamic";

/**
 * 轻量版本探针：前端每隔几秒问一次，看后台是不是换了一份代码在跑。
 * 每次进程启动时记一个启动时间戳，重启就是新的；不碰数据库、不调模型，问多少次都不费事。
 */
const startedAt = Date.now();

export async function GET() {
  return Response.json(
    { startedAt },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}