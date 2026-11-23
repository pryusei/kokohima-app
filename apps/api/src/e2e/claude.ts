// E2E用の偽の Claude API（docs/specs/T-29-wish-suggestion.md「E2E用の偽の Claude」）。src/e2e/entry.ts と単体テストからだけ読み込む。
// 本物と同じストリーミングの形（SSE）で、Web検索の結果と構造化出力の答えを返す

export const E2E_CLAUDE_HOST = "api.anthropic.com";

export type FakeSearchResult = { url: string; title: string };
export type FakeClaudeReply = {
  /** Web検索の結果（空なら検索しない） */
  results: FakeSearchResult[];
  /** 答えの文（構造化出力の JSON の値、または生の文字列） */
  output: unknown;
  stopReason?: "end_turn" | "refusal" | "max_tokens" | "pause_turn";
};

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** 本物の Messages API のストリームと同じ並びのイベントを作る */
export function claudeStreamBody(model: string, reply: FakeClaudeReply): string {
  const events: string[] = [];
  events.push(
    sse("message_start", {
      type: "message_start",
      message: {
        id: `msg_e2e_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 1 },
      },
    }),
  );
  let index = 0;
  if (reply.results.length > 0) {
    const toolUseId = `srvtoolu_e2e_${index}`;
    events.push(
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "server_tool_use", id: toolUseId, name: "web_search", input: {} },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "e2e" }) },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    );
    index++;
    events.push(
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: toolUseId,
          content: reply.results.map((r) => ({
            type: "web_search_result",
            url: r.url,
            title: r.title,
            encrypted_content: "e2e",
            page_age: null,
          })),
        },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    );
    index++;
  }
  const text = typeof reply.output === "string" ? reply.output : JSON.stringify(reply.output);
  events.push(
    sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { type: "content_block_stop", index }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: reply.stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: 300, server_tool_use: { web_search_requests: reply.results.length > 0 ? 1 : 0 } },
    }),
    sse("message_stop", { type: "message_stop" }),
  );
  return events.join("");
}

export const claudeStreamResponse = (model: string, reply: FakeClaudeReply) =>
  new Response(claudeStreamBody(model, reply), { headers: { "Content-Type": "text/event-stream" } });

const SHOPS: FakeSearchResult[] = [
  { url: "https://ogp.e2e.invalid/page", title: "E2E のお店" },
  { url: "https://ogp.e2e.invalid/shop-b", title: "らーめん灯" },
  { url: "https://ogp.e2e.invalid/shop-c", title: "夜鳴きそば ほしの" },
];

/** E2E の決まった答え。query に __empty__・__fail__・__slow__ があれば、0件・500・時間切れ */
function e2eReply(query: string): FakeClaudeReply | "fail" | "slow" {
  if (query.includes("__fail__")) return "fail";
  if (query.includes("__slow__")) return "slow";
  if (query.includes("__empty__")) return { results: SHOPS.slice(0, 1), output: { candidates: [] } };
  return {
    results: SHOPS,
    output: {
      candidates: [
        { message: "E2E のお店のつけ麺行きたい", placeName: "E2E のお店", url: SHOPS[0]!.url, reason: "駅から3分" },
        // 検索の結果にない URL（API が捨てる）
        { message: "幻の店行きたい", placeName: "幻の店", url: "https://ogp.e2e.invalid/made-up", reason: "作った URL" },
        { message: "らーめん灯の塩らーめん行きたい", placeName: "らーめん灯", url: SHOPS[1]!.url, reason: "深夜も開いている" },
        { message: "ほしののしょうゆそば行きたい", placeName: "夜鳴きそば ほしの", url: SHOPS[2]!.url, reason: "2軒めに寄りやすい" },
      ],
    },
  };
}

/** 偽の Claude API への fetch を受ける。ほかの宛先なら null */
export async function e2eClaudeFetch(url: URL, init: RequestInit | undefined): Promise<Response | null> {
  if (url.host !== E2E_CLAUDE_HOST) return null;
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
    model?: string;
    messages?: { content?: unknown }[];
  };
  const first = body.messages?.[0]?.content;
  const query = typeof first === "string" ? first : JSON.stringify(first ?? "");
  const reply = e2eReply(query);
  if (reply === "fail") {
    return Response.json({ type: "error", error: { type: "api_error", message: "e2e" } }, { status: 500 });
  }
  if (reply === "slow") {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
  }
  return claudeStreamResponse(body.model ?? "claude-haiku-5-5", reply);
}
