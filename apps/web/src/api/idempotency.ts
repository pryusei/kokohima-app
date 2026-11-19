import { useMemo, useRef } from "react";
import { ApiError } from "./client";

// 1つの操作ごとに Idempotency-Key を持つ（docs/specs/T-10-idempotency-cache-ratelimit.md「Web」）
// - 同じ内容で送り直すとき（通信できなかった・5xx のあと）は同じキー
// - 4xx・成功・内容の変更のあとは新しいキー（4xx は24時間同じ答えが保存されるため）

export function useIdempotencyKey() {
  const current = useRef<{ signature: string; key: string } | null>(null);
  return useMemo(
    () => ({
      /** 送る内容（経路と本文）ごとのキー。内容が変われば新しいキー */
      keyFor(signature: string) {
        if (current.current?.signature !== signature) current.current = { signature, key: crypto.randomUUID() };
        return current.current.key;
      },
      /** 送り終えたら呼ぶ。通信できなかった・5xx のときだけキーを残す */
      settle(error: unknown) {
        const retryable = error instanceof ApiError && (error.status === 0 || error.status >= 500);
        if (!retryable) current.current = null;
      },
    }),
    [],
  );
}

/** 経路と本文から、キーを分ける目印を作る */
export const signatureOf = (path: string, body: unknown) => `${path}\n${body === undefined ? "" : JSON.stringify(body)}`;
