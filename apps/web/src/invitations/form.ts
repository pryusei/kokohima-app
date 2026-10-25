import type { ExpiresIn } from "@kokohima/shared";
import { ApiError } from "../api/client";
import { addDays, localInstant } from "../availability/format";

// 誘いと募集の作成画面で共有する部品（docs/specs/T-04-direct-invite.md・T-05-broadcast.md「画面」）

export const EXPIRES: { value: ExpiresIn; label: string }[] = [
  { value: "1h", label: "1時間" },
  { value: "3h", label: "3時間" },
  { value: "24h", label: "24時間" },
  { value: "until_start", label: "開始まで" },
];

export function sendErrorText(error: unknown) {
  if (error instanceof ApiError && error.status === 429) return "今日はたくさん誘ったので、少し時間をおいてください";
  if (error instanceof ApiError && error.status === 409) return "同じ時間の誘いをもう送っています";
  if (error instanceof ApiError && error.status === 404) return "この友達には送れませんでした";
  if (error instanceof ApiError && error.status === 400) {
    return "送れませんでした。これからの時間で、15分単位、30分以上24時間以内にしてください。文字数も確かめてください";
  }
  return "送れませんでした。通信状態を確認して、もう一度お試しください";
}

/** 日付と開始・終了（HH:MM）から瞬間を作る。終了が開始以前なら翌日 */
export function rangeOf(date: string, start: string, end: string) {
  const startsAt = localInstant(date, start);
  let endsAt = localInstant(date, end);
  if (endsAt <= startsAt) endsAt = localInstant(addDays(date, 1), end);
  return { startsAt, endsAt };
}

