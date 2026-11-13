// 只做一件事：点通知时把聊天页切到前台（没开就新开一个），并让他看见那条消息
const pick = (data) => {
  const id = Number(data && data.messageId);
  return Number.isFinite(id) && id > 0 ? id : 0;
};

async function findWindow() {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return list.find((c) => new URL(c.url).origin === self.location.origin) ?? null;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const id = pick(event.notification.data);
      const c = await findWindow();
      if (!c) {
        // 页面开着、只是新开的那一个联系不上：让它先打开，打开后页面自己会看地址栏里的 msg 跳过去
        const open = (await self.clients.matchAll({ type: "window" })).length > 0;
        await self.clients.openWindow(open ? "/" : id ? `/?msg=${id}` : "/");
        return;
      }
      try {
        await c.focus();
      } catch {}
      if (id) c.postMessage({ type: "dongni-notify-open", messageId: id });
    })(),
  );
});