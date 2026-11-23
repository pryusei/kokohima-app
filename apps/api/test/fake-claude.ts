import { claudeStreamResponse, E2E_CLAUDE_HOST, type FakeClaudeReply } from "../src/e2e/claude";

// 行きたいのAI提案のテスト用の偽の Claude API（本番のコードからは読み込まない。docs/specs/T-29-wish-suggestion.md「テスト計画」）
// 受けたリクエストを記録し、次の応答をテストから決める

export type ClaudeRequest = { url: string; headers: Headers; json: Record<string, unknown> };
type Next = FakeClaudeReply | { status: number } | "hang" | "throw";

export function createFakeClaude() {
  const state = {
    requests: [] as ClaudeRequest[],
    /** 次の応答（1回ずつ取り出す）。空なら既定の答え */
    next: [] as Next[],
  };

  const handles = (url: URL) => url.host === E2E_CLAUDE_HOST;

  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const json = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    state.requests.push({ url: url.toString(), headers: new Headers(init?.headers), json });
    const next = state.next.shift() ?? DEFAULT_REPLY;
    if (next === "throw") throw new TypeError("Network connection lost.");
    if (next === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    }
    if ("status" in next) {
      return Response.json({ type: "error", error: { type: "api_error", message: "fake" } }, { status: next.status });
    }
    return claudeStreamResponse(String(json.model ?? ""), next);
  }

  return { state, handles, handle };
}

export const SHOP_A = { url: "https://shop.example/komorebi", title: "麺処こもれび" };
export const SHOP_B = { url: "https://shop.example/akari/", title: "らーめん灯" };
export const SHOP_C = { url: "https://SHOP.example/hoshino#menu", title: "夜鳴きそば ほしの" };

export const candidate = (url: string, over: Record<string, unknown> = {}) => ({
  message: "こもれびのつけ麺行きたい",
  placeName: "麺処こもれび",
  url,
  reason: "夜2時まで",
  ...over,
});

export const DEFAULT_REPLY: FakeClaudeReply = {
  results: [SHOP_A, SHOP_B, SHOP_C],
  output: {
    candidates: [
      candidate(SHOP_A.url),
      candidate("https://shop.example/made-up", { placeName: "幻の店" }),
      candidate("https://shop.example/akari", { placeName: "らーめん灯" }),
      candidate("https://shop.example/hoshino", { placeName: "夜鳴きそば ほしの" }),
    ],
  },
};
