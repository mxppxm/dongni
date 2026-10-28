// 只做一件事：点通知时把聊天页切到前台（没开就新开一个）
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          return;
        }
      }
      await self.clients.openWindow("/");
    })(),
  );
});
