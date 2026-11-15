import type { Draft } from "./kinds";

// outbox のイベント → お知らせの下書き（docs/specs/T-07-notification.md「種別と受け取り手」）
// payload だけで決まらないもの（募集者、予定を成立させた人、前のセッションの有無）は lookups で受け取る

export type Lookups = {
  /** 募集者（BroadcastDecided） */
  broadcastOwner?: string | null;
  /** 予定を成立させた操作をした人（直接の誘いの MeetupConfirmed） */
  inviteActor?: string | null;
  /** このセッションより前に作られたセッションがあるか（SessionStarted） */
  hasEarlierSession?: boolean;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const one = (
  userId: string | null,
  kind: Draft["kind"],
  rest: Partial<Omit<Draft, "userId" | "kind">> = {},
): Draft[] =>
  userId ? [{ userId, kind, actorId: null, subjectId: null, count: null, device: null, ...rest }] : [];

const many = (userIds: string[], except: string | null, kind: Draft["kind"], rest: Partial<Draft>): Draft[] =>
  [...new Set(userIds)].filter((id) => id !== except).flatMap((id) => one(id, kind, rest));

/** この型でお知らせを作るか（作らない型は空の配列） */
export function draftsFor(type: string, payload: Record<string, unknown>, lookups: Lookups = {}): Draft[] {
  const userId = str(payload.userId);
  const actorId = str(payload.actorId);
  switch (type) {
    case "DirectInviteSent":
      return one(userId, "invite_received", { actorId, subjectId: str(payload.inviteId) });
    case "DirectInviteDeclined":
      return one(userId, "invite_declined", { actorId, subjectId: str(payload.inviteId) });
    case "DirectInviteCounterProposed":
      return one(userId, "invite_countered", { actorId, subjectId: str(payload.inviteId) });
    case "DirectInviteSkipped":
      return one(userId, "invite_skipped", { actorId, subjectId: str(payload.inviteId) });
    case "BroadcastSent":
      return one(userId, "broadcast_received", { actorId, subjectId: str(payload.broadcastId) });
    case "BroadcastDecided": {
      const owner = lookups.broadcastOwner ?? null;
      return many(ids(payload.participantIds), owner, "broadcast_decided", {
        actorId: owner,
        subjectId: str(payload.broadcastId),
      });
    }
    case "MeetupConfirmed": {
      // 募集の予定（inviteId が null）は BroadcastDecided で知らせる
      if (str(payload.inviteId) === null) return [];
      const actor = lookups.inviteActor ?? null;
      return many(ids(payload.participantIds), actor, "meetup_confirmed", {
        actorId: actor,
        subjectId: str(payload.meetupId),
      });
    }
    case "MeetupCancelled":
      return many(ids(payload.participantIds), actorId, "meetup_cancelled", { subjectId: str(payload.meetupId) });
    case "MeetupLeft":
      // participantIds は残った人。抜けた人の名前は出さないので actor を持たない
      return many(ids(payload.participantIds), null, "meetup_left", { subjectId: str(payload.meetupId) });
    case "FriendshipEstablished":
      return one(userId, "friend_added", { actorId: str(payload.friendId), subjectId: str(payload.friendId) });
    case "AvailabilityCancelledByCalendar":
      return one(userId, "availability_cancelled", {
        count: Array.isArray(payload.ranges) ? payload.ranges.length : 0,
      });
    case "CalendarReauthRequired":
      return one(userId, "calendar_reauth");
    case "SessionStarted":
      return lookups.hasEarlierSession
        ? one(userId, "new_login", { device: str(payload.deviceSummary), subjectId: str(payload.sessionId) })
        : [];
    default:
      return [];
  }
}

/** お知らせを作る型（T-07 で新しく取り出す、通知だけの型） */
export const NOTIFICATION_ONLY_TYPES = [
  "SessionStarted",
  "FriendshipEstablished",
  "DirectInviteSent",
  "DirectInviteDeclined",
  "DirectInviteCounterProposed",
  "DirectInviteSkipped",
  "BroadcastSent",
  "BroadcastDecided",
  "CalendarReauthRequired",
] as const;
