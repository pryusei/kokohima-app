// 問い合わせの webhook の URL の確かめ（docs/specs/T-24-contact.md「振る舞い 3.」の4）。純粋な関数だけ
// 設定の誤りで、別の宛先に個人情報を送らないため

export type WebhookTarget = { hostname: string; pathPrefix: string };

/** 既定の許す宛先。差し替えるのは E2E のエントリだけ（AppDeps.contactWebhookTarget） */
export const CONTACT_WEBHOOK_TARGET: WebhookTarget = { hostname: "hooks.slack.com", pathPrefix: "/services/" };

/**
 * 送ってよい URL なら、その URL。https・ホスト名が同じ・ポートなし・接頭辞で始まる、のどれかが違う、値がない、
 * new URL() が例外になるときは null
 */
export function checkWebhookUrl(raw: string | undefined, target: WebhookTarget): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== target.hostname) return null;
  if (url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!url.pathname.startsWith(target.pathPrefix)) return null;
  return url;
}

/** webhook の URL が未設定・形が違う（例外の message に URL を入れない） */
export class ContactWebhookNotConfigured extends Error {
  override name = "ContactWebhookNotConfigured";
  constructor() {
    super("contact_webhook_not_configured");
  }
}

/** Slack が 200 以外を返した・通信できなかった（例外の message に URL・応答の本文・内容を入れない） */
export class ContactWebhookRejected extends Error {
  override name = "ContactWebhookRejected";
  constructor(readonly status: number) {
    super("contact_webhook_rejected");
  }
}
