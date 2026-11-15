// ここ暇の Service Worker（docs/specs/T-07-notification.md「プッシュの購読と Service Worker」）
// プッシュは中身を持たない。決まった文言を出すだけで、API を呼ばず、キャッシュもしない

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("ここ暇", { body: "新しいお知らせがあります", tag: "kokohima" }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/notifications"));
});
