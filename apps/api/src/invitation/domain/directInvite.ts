// 個別の誘いの規則（docs/specs/T-04-direct-invite.md「振る舞い」）。Cloudflare・D1・Hono・fetch を import しない

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const QUARTER_MS = 15 * MINUTE_MS;
export const MIN_LENGTH_MS = 30 * MINUTE_MS;
export const MAX_LENGTH_MS = DAY_MS;
export const HORIZON_MS = 60 * DAY_MS;
/** 直近24時間に送れる誘いの数（T-05 で募集とあわせて数える） */
export const DAILY_SEND_LIMIT = 20;
export const SEND_WINDOW_MS = DAY_MS;

export type InviteKind = "asobo" | "kokodou";
export type StoredStatus = "pending" | "counter_proposed" | "confirmed" | "declined" | "skipped" | "cancelled";
export type InviteStatus = StoredStatus | "expired";
export type ExpiresIn = "1h" | "3h" | "24h" | "until_start";

export type TimeError = "not_quarter" | "too_short" | "too_long" | "in_past" | "too_far";

/** 誘い・代わりの時間の検証。開始は現在より後、60日以内、15分単位、30分以上24時間以下 */
export function checkInviteTime(startsAt: number, endsAt: number, now: number): TimeError | null {
  if (startsAt % QUARTER_MS !== 0 || endsAt % QUARTER_MS !== 0) return "not_quarter";
  const length = endsAt - startsAt;
  if (length < MIN_LENGTH_MS) return "too_short";
  if (length > MAX_LENGTH_MS) return "too_long";
  if (startsAt <= now) return "in_past";
  if (startsAt - now > HORIZON_MS) return "too_far";
  return null;
}

const EXPIRES_IN_MS: Record<Exclude<ExpiresIn, "until_start">, number> = {
  "1h": HOUR_MS,
  "3h": 3 * HOUR_MS,
  "24h": DAY_MS,
};

/** 返事の期限。選んだ時間と開始日時の早いほう（決定事項1） */
export function expiresAtFor(expiresIn: ExpiresIn, startsAt: number, now: number): number {
  if (expiresIn === "until_start") return startsAt;
  return Math.min(now + EXPIRES_IN_MS[expiresIn], startsAt);
}

type Range = { startsAt: number; endsAt: number };

/** 送信者に見えている相手の枠のどれかと1分以上重なれば「あそぼ」。接するだけは「ここどう？」 */
export function kindFor(visibleSlots: Range[], invite: Range): InviteKind {
  const overlaps = visibleSlots.some(
    (s) => Math.min(s.endsAt, invite.endsAt) - Math.max(s.startsAt, invite.startsAt) >= MINUTE_MS,
  );
  return overlaps ? "asobo" : "kokodou";
}

export type InviteTimes = {
  status: StoredStatus;
  expiresAt: number;
  counterStartsAt: number | null;
};

/** 読み出しの状態。期限切れは保存せず、ここで決める（決定事項8を含む） */
export function effectiveStatus(invite: InviteTimes, now: number): InviteStatus {
  if (invite.status === "pending" && invite.expiresAt <= now) return "expired";
  if (invite.status === "counter_proposed" && invite.counterStartsAt !== null && invite.counterStartsAt <= now) {
    return "expired";
  }
  return invite.status;
}

export type TransitionError = "invalid_state" | "expired";

/**
 * 条件付き UPDATE が0行だったときの理由。保存した status が必要な状態でなければ invalid_state、
 * 必要な状態のままで時間の条件を過ぎていれば expired（api-conventions の判定の順）
 */
export function respondError(invite: InviteTimes, now: number): TransitionError | null {
  if (invite.status !== "pending") return "invalid_state";
  if (invite.expiresAt <= now) return "expired";
  return null;
}

export function decideError(invite: InviteTimes, now: number): TransitionError | null {
  if (invite.status !== "counter_proposed") return "invalid_state";
  if (invite.counterStartsAt === null || invite.counterStartsAt <= now) return "expired";
  return null;
}

export type MeetupStatus = "confirmed" | "cancelled";

/** 「やっぱり難しい」は開始前まで（決定事項4） */
export function cancelError(meetup: { status: MeetupStatus; startsAt: number }, now: number): TransitionError | null {
  if (meetup.status !== "confirmed") return "invalid_state";
  if (meetup.startsAt <= now) return "expired";
  return null;
}

/** 「この時間なら」は元の時間とまったく同じなら不可 */
export function isSameRange(a: Range, b: Range) {
  return a.startsAt === b.startsAt && a.endsAt === b.endsAt;
}

/** 送信上限の Retry-After（秒）。いちばん古い送信が24時間を過ぎるまで */
export function retryAfterSeconds(oldestInWindow: number, now: number): number {
  return Math.max(1, Math.ceil((oldestInWindow + SEND_WINDOW_MS - now) / 1000));
}
