import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api/client";

/** 取り直さずにキャッシュを使う時間（docs/specs/T-49-perf-small-fixes.md「3.」） */
export const STALE_TIME_MS = 30_000;

/** 失敗した取得を取り直す回数の上限（TanStack Query の既定と同じ3回） */
const MAX_RETRIES = 3;

/**
 * 既定の再試行。4xx（見られない・ない・回数の上限など）は何度読んでも同じなので取り直さない。
 * 通信できなかった（status 0）・5xx・API の外の失敗は、3回まで取り直す
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < MAX_RETRIES;
}

// キャッシュは永続化しない（個人情報を含むため。data-fetching スキル参照）
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: true, staleTime: STALE_TIME_MS, retry: shouldRetry },
    },
  });
}
