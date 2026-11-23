import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, userPrompt } from "../domain/suggestion";

// Claude API の呼び出し（腐敗防止層。docs/specs/T-29-wish-suggestion.md「Claude の呼び方」）。
// domain は Claude を知らない。ここは「エリアと言葉 → 検索の結果の URL と、構造化出力の生の値」だけを返す

export type ClaudeCall = {
  apiKey: string;
  model: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  area: string;
  query: string;
  /** 進み具合（Web検索が始まった・答えを書き始めた）。それぞれ多くて1回 */
  onProgress: (stage: "searching" | "choosing") => void;
};

export type ClaudeResult =
  | { kind: "ok"; output: unknown; searchUrls: string[]; usage: Usage }
  | { kind: "failed"; reason: FailureReason; status: number | null; stopReason: string | null; usage: Usage | null };

export type FailureReason = "api_error" | "timeout" | "aborted" | "refusal" | "bad_output" | "incomplete";
export type Usage = { inputTokens: number; outputTokens: number; searches: number };

const MAX_TOKENS = 4000;
const MAX_SEARCHES = 3;
/** pause_turn（サーバーのツールの途中で止まった）のとき、続きを頼む回数 */
const MAX_CONTINUATIONS = 1;

export async function searchCandidates(call: ClaudeCall): Promise<ClaudeResult> {
  // 宛先と資格情報は明示する（環境変数の ANTHROPIC_BASE_URL・ANTHROPIC_AUTH_TOKEN などを読ませない）。再試行は画面に任せる
  const client = new Anthropic({ apiKey: call.apiKey, baseURL: "https://api.anthropic.com", fetch: call.fetch, maxRetries: 0 });
  const messages: MessageParam[] = [{ role: "user", content: userPrompt(call.area, call.query) }];
  const sent = { searching: false, choosing: false };
  const progress = (stage: "searching" | "choosing") => {
    if (sent[stage]) return;
    sent[stage] = true;
    call.onProgress(stage);
  };
  const usage: Usage = { inputTokens: 0, outputTokens: 0, searches: 0 };
  const content: ContentBlock[] = [];

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    let message: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        {
          model: call.model,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: MAX_SEARCHES,
              user_location: { type: "approximate", country: "JP" },
            },
          ],
          output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        },
        { signal: call.signal },
      );
      for await (const event of stream) {
        if (event.type !== "content_block_start") continue;
        if (event.content_block.type === "server_tool_use") progress("searching");
        // 答えの文が始まった。途中の文（検査の前の URL）は画面に送らない
        if (event.content_block.type === "text" && sent.searching) progress("choosing");
      }
      message = await stream.finalMessage();
    } catch (e) {
      return { kind: "failed", reason: failureOf(e, call.signal), status: statusOf(e), stopReason: null, usage };
    }
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.searches += message.usage.server_tool_use?.web_search_requests ?? 0;
    content.push(...message.content);
    if (message.stop_reason === "refusal") {
      return { kind: "failed", reason: "refusal", status: null, stopReason: message.stop_reason, usage };
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    if (message.stop_reason !== "end_turn") {
      return { kind: "failed", reason: "incomplete", status: null, stopReason: message.stop_reason, usage };
    }
    const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let output: unknown;
    try {
      output = JSON.parse(lastJsonObject(text));
    } catch {
      return { kind: "failed", reason: "bad_output", status: null, stopReason: message.stop_reason, usage };
    }
    return { kind: "ok", output, searchUrls: searchUrlsOf(content), usage };
  }
  return { kind: "failed", reason: "incomplete", status: null, stopReason: "pause_turn", usage };
}

/** 検索の結果に出てきた URL（エラーの結果は数えない） */
function searchUrlsOf(content: readonly ContentBlock[]): string[] {
  return content.flatMap((b) =>
    b.type === "web_search_tool_result" && Array.isArray(b.content) ? b.content.map((r) => r.url) : [],
  );
}

/** 検索の前後に短い文がはさまることがあるので、最後の `{` から始まる JSON を読む（構造化出力なら文全体が JSON） */
function lastJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const at = trimmed.lastIndexOf('{"candidates"');
  return at >= 0 ? trimmed.slice(at) : trimmed;
}

function failureOf(e: unknown, signal: AbortSignal): FailureReason {
  if (signal.aborted) return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "aborted";
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  return "api_error";
}

const statusOf = (e: unknown) => (e instanceof Anthropic.APIError && typeof e.status === "number" ? e.status : null);
