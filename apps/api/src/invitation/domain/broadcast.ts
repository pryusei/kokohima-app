import type { TransitionError } from "./directInvite";

// 募集の規則（docs/specs/T-05-broadcast.md「振る舞い」）。Cloudflare・D1・Hono・fetch を import しない

export type StoredBroadcastStatus = "open" | "decided";
export type BroadcastStatus = "open" | "expired" | "decided" | "closed";

export type BroadcastView = {
  stored: StoredBroadcastStatus;
  expiresAt: number;
  /** 閲覧者が募集者か */
  isOwner: boolean;
  /** 閲覧者がこの募集から作った予定の参加者か（決めた時点で応じていた人。抜けた人を含む） */
  isParticipant: boolean;
};

/**
 * 閲覧者から見た状態。参加者でない宛先の人には、決まったかどうかを伝えない（決定事項6）：
 * 期限前は open、期限後は closed（決まった募集も期限切れの募集も同じ）
 */
export function viewerStatus(view: BroadcastView, now: number): BroadcastStatus {
  const expired = view.expiresAt <= now;
  if (view.isOwner) {
    if (view.stored === "decided") return "decided";
    return expired ? "expired" : "open";
  }
  if (view.isParticipant) return "decided";
  return expired ? "closed" : "open";
}

/** 募集者に見せる人数。決める前は今応じている人数、決めた後は決めた時点で予定に入った人数 */
export function ownerResponseCount(stored: StoredBroadcastStatus, responding: number, participantCount: number) {
  return stored === "decided" ? Math.max(0, participantCount - 1) : responding;
}

/** 応じる・やめるが0行だったときの理由。参加者には invalid_state、それ以外は期限切れ（決まった募集でも同じ） */
export function respondError(view: { isParticipant: boolean; expiresAt: number }, now: number): TransitionError | null {
  if (view.isParticipant) return "invalid_state";
  if (view.expiresAt <= now) return "expired";
  return null;
}

/** 決めるが0行だったときの理由（状態 → 期限 → 応じた人の順） */
export function decideError(
  view: { stored: StoredBroadcastStatus; expiresAt: number; responding: number },
  now: number,
): TransitionError | null {
  if (view.stored !== "open") return "invalid_state";
  if (view.expiresAt <= now) return "expired";
  if (view.responding < 1) return "invalid_state";
  return null;
}

/** 募集の予定で「やっぱり難しい」が0行だったときの理由 */
export function leaveError(
  view: { left: boolean; status: "confirmed" | "cancelled"; startsAt: number },
  now: number,
): TransitionError | null {
  if (view.left || view.status !== "confirmed") return "invalid_state";
  if (view.startsAt <= now) return "expired";
  return null;
}
