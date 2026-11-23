import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client";
import { STALE_TIME_MS, createQueryClient, shouldRetry } from "./queryClient";

describe("QueryClient の既定（docs/specs/T-49-perf-small-fixes.md「3.」）", () => {
  it("4xx は取り直さない（400・401・403・404・409・429・499）", () => {
    for (const status of [400, 401, 403, 404, 409, 429, 499]) {
      expect(shouldRetry(0, new ApiError(status)), String(status)).toBe(false);
    }
  });

  it("通信できなかった・5xx・API の外の失敗は3回まで取り直す", () => {
    for (const error of [new ApiError(0), new ApiError(500), new ApiError(503), new Error("parse")]) {
      expect(shouldRetry(0, error)).toBe(true);
      expect(shouldRetry(2, error)).toBe(true);
      expect(shouldRetry(3, error)).toBe(false);
    }
  });

  it("staleTime は30秒、ウィンドウに戻ったら取り直す", () => {
    const defaults = createQueryClient().getDefaultOptions().queries;
    expect(STALE_TIME_MS).toBe(30_000);
    expect(defaults?.staleTime).toBe(30_000);
    expect(defaults?.refetchOnWindowFocus).toBe(true);
    expect(defaults?.retry).toBe(shouldRetry);
  });
});
