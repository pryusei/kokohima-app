import { useMemo, useRef } from "react";
import { ApiError } from "./client";

// 1つの操作ごとに Idempotency-Key を持つ（docs/specs/T-10-idempotency-cache-ratelimit.md「Web」）
// - 同じ内容で送り直すとき（通信できなかった・5xx のあと）は同じキー
// - 4xx・成功・内容の変更のあとは新しいキー（4xx は24時間同じ答えが保存されるため）

/** 通信できなかった・5xx（同じ内容で送り直すときは同じキー） */
const isRetryable = (error: unknown) => error instanceof ApiError && (error.status === 0 || error.status >= 500);

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
        if (!isRetryable(error)) current.current = null;
      },
    }),
    [],
  );
}

/**
 * 送る内容ごとに別のキーを同時に持つ。1つの useMutation で、別々の内容を続けて（前の応答を待たずに）送るとき（週の帯のマス）。
 * 決まりは useIdempotencyKey と同じで、内容ごとに覚える
 */
export function useIdempotencyKeys() {
  const current = useRef(new Map<string, string>());
  return useMemo(
    () => ({
      keyFor(signature: string) {
        let key = current.current.get(signature);
        if (!key) {
          key = crypto.randomUUID();
          current.current.set(signature, key);
        }
        return key;
      },
      /** その内容を送り終えたら呼ぶ。通信できなかった・5xx のときだけキーを残す */
      settle(signature: string, error: unknown) {
        if (!isRetryable(error)) current.current.delete(signature);
      },
    }),
    [],
  );
}


/** 経路と本文から、キーを分ける目印を作る */
export const signatureOf = (path: string, body: unknown) => `${path}\n${body === undefined ? "" : JSON.stringify(body)}`;
