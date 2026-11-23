import { RETENTION, RETENTION_UNIT_MS, type CreateWishSuggestionRequest, type WishSuggestionCandidate } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { getUserTimezone } from "../../identity/application/auth";
import {
  acceptCandidates,
  admission,
  localDayBounds,
  readSuggestConfig,
  remaining,
  retryAfterSeconds,
  utcDayStart,
} from "../domain/suggestion";
import { searchCandidates } from "../infra/claude";
import * as repo from "../infra/suggestionRepository";

// 行きたいのAI提案（docs/specs/T-29-wish-suggestion.md）。本人がその場で待つ読み取りなので、API から Claude を直接呼ぶ（決めたこと5）

type Ctx = { env: Bindings; deps: AppDeps };

async function bounds(ctx: Ctx, viewerId: string) {
  const now = ctx.deps.now();
  const day = localDayBounds(now, await getUserTimezone(ctx.env, viewerId));
  return { b: { now, localStart: day.start, utcStart: utcDayStart(now) }, nextDay: day.end };
}

/** 今日あと何回探せるか。設定がなければ limit 0（画面は「AIで探す」を出さない） */
export async function quota(ctx: Ctx, viewerId: string) {
  const config = readSuggestConfig(ctx.env);
  if (!config) return { remaining: 0, limit: 0 };
  const { b } = await bounds(ctx, viewerId);
  const counts = await repo.countAttempts(ctx.env.DB, viewerId, b);
  return { remaining: remaining(counts, config), limit: config.userDailyLimit };
}

export type Emit = {
  progress: (stage: "searching" | "choosing") => Promise<void>;
  result: (candidates: WishSuggestionCandidate[]) => Promise<void>;
};

export type Started =
  | { kind: "unavailable" }
  | { kind: "in_flight" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  /** run：clientSignal は画面が閉じた・通信が切れたとき。全体の時間の上限はこの中でかける */
  | { kind: "ok"; run: (emit: Emit, clientSignal: AbortSignal) => Promise<void> };

type Input = { [K in keyof CreateWishSuggestionRequest]-?: string };

/** 回数を数える行を足す。足せたら、Claude を呼んで結果を送る関数を返す（ストリームを開いてから呼ぶ） */
export async function startSuggestion(ctx: Ctx, viewerId: string, input: Input): Promise<Started> {
  const config = readSuggestConfig(ctx.env);
  if (!config) {
    console.log(JSON.stringify({ event: "wish_suggest_config_invalid" }));
    return { kind: "unavailable" };
  }
  const d1 = ctx.env.DB;
  const { b, nextDay } = await bounds(ctx, viewerId);
  const id = crypto.randomUUID();
  if (!(await repo.insertAttempt(d1, id, viewerId, b, config))) {
    const why = admission(await repo.countAttempts(d1, viewerId, b), config);
    if (why.kind === "in_flight") return { kind: "in_flight" };
    if (why.kind === "global_limited") {
      console.log(JSON.stringify({ event: "wish_suggest_global_limit" }));
      return { kind: "unavailable" };
    }
    // ok（同時に消えた・退会した）も、上限と同じ扱いにする
    return { kind: "rate_limited", retryAfterSeconds: retryAfterSeconds(b.now, nextDay) };
  }

  return {
    kind: "ok",
    run: async (emit, clientSignal) => {
      const startedAt = ctx.deps.now();
      const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(ctx.deps.wishSuggest.timeoutMs)]);
      const result = await searchCandidates({
        apiKey: config.apiKey,
        model: config.model,
        fetch: ctx.deps.fetch,
        signal,
        area: input.area,
        query: input.query,
        onProgress: (stage) => void emit.progress(stage).catch(() => undefined),
      });
      const candidates = result.kind === "ok" ? acceptCandidates(result.output, result.searchUrls) : [];
      const outcome = result.kind === "failed" ? "failed" : candidates.length > 0 ? "found" : "empty";
      await repo.finishAttempt(d1, id, outcome, ctx.deps.now());
      // ログは結果の種類と数だけ。入力の言葉・候補・URL・応答の本文は出さない
      console.log(
        JSON.stringify({
          event: "wish_suggest_call",
          outcome,
          reason: result.kind === "failed" ? result.reason : null,
          status: result.kind === "failed" ? result.status : null,
          stopReason: result.kind === "failed" ? result.stopReason : null,
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          searches: result.usage?.searches ?? null,
          candidates: candidates.length,
          ms: ctx.deps.now() - startedAt,
        }),
      );
      // 時間切れは0件の result で閉じる。画面が閉じたときは送らない
      if (!clientSignal.aborted) await emit.result(candidates);
    },
  };
}

/** 掃除（T-17）：UTC で3日前の日付より前の行を消す */
export const deleteOldAttempts = (d1: D1Database, now: number, limit: number) =>
  repo.deleteAttemptsBefore(
    d1,
    utcDayStart(now) - RETENTION.wishSuggestionAttemptsDaysBefore * RETENTION_UNIT_MS.day,
    limit,
  );

export const withdrawalPurgeStatements = (d1: D1Database, userId: string) => repo.withdrawalPurgeStatements(d1, userId);
