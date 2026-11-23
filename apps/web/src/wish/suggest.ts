import {
  wishSuggestionProgressSchema,
  wishSuggestionQuotaSchema,
  wishSuggestionResultSchema,
  type WishSuggestionCandidate,
} from "@kokohima/shared";
import { apiFetch, apiGet } from "../api/client";
import { keys } from "../api/keys";

// 行きたいのAI提案の API（docs/specs/T-29-wish-suggestion.md「API」「画面」）。
// EventSource は Authorization を送れないので、fetch の本文をストリームとして読む。候補はメモリにだけ持つ

export type Stage = "waiting" | "searching" | "choosing";

/** 今日あと何回探せるか。limit が0なら「AIで探す」を出さない */
export const suggestionQuotaQuery = () => ({
  queryKey: keys.wishes.suggestionQuota(),
  queryFn: () => apiGet("/api/v1/wish-suggestions/quota", wishSuggestionQuotaSchema),
});

/** 本文を SSE のイベント（event と data の組）に分ける。コメントの行（`: keep-alive`）は捨てる */
export function parseSseChunk(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events = parts.flatMap((block) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return data.length > 0 ? [{ event, data: data.join("\n") }] : [];
  });
  return { events, rest };
}

/**
 * 探す。進み具合は onStage で知らせ、最後の result の候補を返す。
 * ストリームの前のエラー（400・409・429・503）は ApiError のまま投げる。result が来ないまま閉じたら0件と同じに扱う
 */
export async function streamWishSuggestion(
  body: { area: string; query: string },
  options: { signal: AbortSignal; onStage: (stage: Stage) => void },
): Promise<WishSuggestionCandidate[]> {
  const res = await apiFetch("/api/v1/wish-suggestions", {
    method: "POST",
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const reader = res.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      for (const e of parsed.events) {
        if (e.event === "progress") {
          const p = wishSuggestionProgressSchema.safeParse(JSON.parse(e.data));
          if (p.success) options.onStage(p.data.stage);
        }
        if (e.event === "result") {
          const r = wishSuggestionResultSchema.safeParse(JSON.parse(e.data));
          return r.success ? (r.data.candidates as WishSuggestionCandidate[]) : [];
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return [];
}
