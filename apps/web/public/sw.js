// ここ暇の Service Worker（docs/specs/T-07-notification.md「プッシュの購読と Service Worker」、
// docs/specs/T-35-notification-visibility.md「Service Worker」）
// 中身はサーバーが暗号化して送り、ブラウザが復号したもの（{ v, id, body }）。本文は種類に応じた文で、
// 本人が選んだときだけ相手の名前と日時が入る。中身がない（鍵のない古い購読）・読めないときは決まった文を出す。
// API を呼ばず、キャッシュもしない

const FALLBACK_BODY = "新しいお知らせがあります";
const MAX_BODY = 200;

function contentOf(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (data && data.v === 1 && typeof data.body === "string" && data.body.length > 0) {
      return {
        body: data.body.slice(0, MAX_BODY),
        // 同じお知らせの再送は1つにまとめ、別のお知らせは並べる
        tag: typeof data.id === "string" ? `kokohima-${data.id}` : "kokohima",
      };
    }
  } catch {
    // 読めない中身は決まった文にする
  }
  return { body: FALLBACK_BODY, tag: "kokohima" };
}

self.addEventListener("push", (event) => {
  const { body, tag } = contentOf(event);
  event.waitUntil(self.registration.showNotification("ここ暇", { body, tag }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/notifications"));
});
