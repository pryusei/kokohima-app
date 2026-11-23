// 通知のテスト用の偽の Resend・偽のプッシュのサービス（本番のコードからは読み込まない）
// 受けたリクエストを記録し、テストから「何を外に渡したか」を確かめられるようにする

export type SentMail = { to: string[]; from: string; subject: string; text: string; html?: string; idempotencyKey: string | null; authorization: string | null };
export type SentPush = { url: string; headers: Record<string, string>; bodyLength: number; redirect: string | undefined };

export function createFakeDelivery() {
  const state = {
    mails: [] as SentMail[],
    pushes: [] as SentPush[],
    /** 次のメールの応答（1回だけ）。throw は通信できない・タイムアウト */
    mailNext: [] as (number | "throw" | { status: number; body: unknown })[],
    /** endpoint ごとのプッシュの応答（既定は 201） */
    pushStatus: new Map<string, number | "throw">(),
  };

  const isResend = (url: URL) => url.host === "api.resend.com";
  const isPush = (url: URL) =>
    url.host === "fcm.googleapis.com" || url.host === "updates.push.services.mozilla.com" || url.host.endsWith(".push.apple.com");

  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (isResend(url)) {
      const next = state.mailNext.shift();
      if (next === "throw") throw new DOMException("The operation timed out.", "TimeoutError");
      const body = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; from: string; subject: string; text: string; html?: string };
      if (typeof next === "number") return Response.json({ name: "error" }, { status: next });
      if (next && typeof next === "object") return Response.json(next.body, { status: next.status });
      state.mails.push({
        ...body,
        idempotencyKey: headers.get("Idempotency-Key"),
        authorization: headers.get("Authorization"),
      });
      return Response.json({ id: crypto.randomUUID() });
    }
    const status = state.pushStatus.get(url.toString()) ?? 201;
    if (status === "throw") throw new DOMException("The operation timed out.", "TimeoutError");
    const bodyLength = init?.body == null ? 0 : String(init.body).length;
    state.pushes.push({ url: url.toString(), headers: Object.fromEntries(headers.entries()), bodyLength, redirect: init?.redirect });
    return new Response(null, { status });
  }

  return { state, handles: (url: URL) => isResend(url) || isPush(url), handle };
}
