// 問い合わせのテスト用の偽の Slack の Incoming Webhook（本番のコードからは読み込まない。docs/specs/T-24-contact.md「8.」）
// 受けたリクエストを記録し、テストから「何を外に渡したか」を確かめられるようにする

export type SlackPost = { url: string; body: string; json: unknown; redirect: string | undefined; contentType: string | null };

export function createFakeSlack() {
  const state = {
    posts: [] as SlackPost[],
    /** 次の応答（1回ずつ取り出す）。throw は通信できない、hang は応答しない（打ち切りを待つ） */
    next: [] as (number | "throw" | "hang")[],
    /** 送ったあと（応答を返す前）に呼ぶ（送信と重なった退会のテスト） */
    onPost: null as null | (() => Promise<void>),
  };

  const handles = (url: URL) => url.hostname === "hooks.slack.com" || url.hostname.endsWith(".slack.test");

  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const next = state.next.shift();
    if (next === "throw") throw new TypeError("Network connection lost.");
    if (next === "hang") {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError")));
      });
    }
    const body = String(init?.body ?? "");
    state.posts.push({
      url: url.toString(),
      body,
      json: JSON.parse(body) as unknown,
      redirect: init?.redirect,
      contentType: new Headers(init?.headers).get("Content-Type"),
    });
    if (state.onPost) await state.onPost();
    if (typeof next === "number") {
      return next >= 300 && next < 400
        ? new Response(null, { status: next, headers: { Location: "https://evil.example/" } })
        : new Response("error", { status: next });
    }
    return new Response("ok", { status: 200 });
  }

  return { state, handles, handle };
}
