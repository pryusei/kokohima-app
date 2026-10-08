import type { InviteKind, MeetupStatus, StoredStatus } from "../domain/directInvite";

// 個別の誘いと成立した予定の永続化（docs/specs/T-04-direct-invite.md「データ」「振る舞い」）
// 閲覧者IDは必ず条件に含める。状態遷移は WHERE status = ? の条件付き UPDATE で行い、
// 同じ batch の後続の文は「この遷移で書いた transition_id がそこにあるか」を EXISTS で見て書く

export type InviteRow = {
  id: string;
  sender_id: string;
  recipient_id: string;
  kind: InviteKind;
  starts_at: number;
  ends_at: number;
  area: string | null;
  message: string | null;
  url: string | null;
  status: StoredStatus;
  expires_at: number;
  counter_starts_at: number | null;
  counter_ends_at: number | null;
  created_at: number;
  meetup_id: string | null;
};

export type MeetupRow = {
  id: string;
  direct_invite_id: string | null;
  starts_at: number;
  ends_at: number;
  status: MeetupStatus;
  created_at: number;
  area: string | null;
  message: string | null;
  url: string | null;
};

const INVITE_COLUMNS = `i.id, i.sender_id, i.recipient_id, i.kind, i.starts_at, i.ends_at, i.area, i.message, i.url,
  i.status, i.expires_at, i.counter_starts_at, i.counter_ends_at, i.created_at,
  (SELECT m.id FROM meetups m WHERE m.direct_invite_id = i.id) AS meetup_id`;

/** 両方向の友達関係の行がそろっているか（?1 と ?2 の間） */
const MUTUAL_FRIENDS = `EXISTS (SELECT 1 FROM friendships WHERE user_id = ?1 AND friend_id = ?2)
  AND EXISTS (SELECT 1 FROM friendships WHERE user_id = ?2 AND friend_id = ?1)`;

/** 同じ相手・同じ時間の、まだ生きている誘い（?1 送信者、?2 相手、?3 開始、?4 終了、?5 現在） */
const LIVE_SAME_INVITE = `EXISTS (
  SELECT 1 FROM direct_invites
  WHERE sender_id = ?1 AND recipient_id = ?2 AND starts_at = ?3 AND ends_at = ?4
    AND ((status = 'pending' AND expires_at > ?5) OR (status = 'counter_proposed' AND counter_starts_at > ?5))
)`;

export type NewInvite = {
  id: string;
  senderId: string;
  recipientId: string;
  kind: InviteKind;
  startsAt: number;
  endsAt: number;
  area: string | null;
  message: string | null;
  url: string | null;
  expiresAt: number;
  now: number;
};

/**
 * 友達であること・同じ誘いが生きていないこと・送信上限を、追加と同じ1つの文で判定して書く。
 * outbox は追加した行があるときだけ書く。追加できたら true
 */
export async function insertInvite(
  d1: D1Database,
  row: NewInvite,
  limit: { count: number; since: number },
  event: { id: string; payload: string },
) {
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO direct_invites
           (id, sender_id, recipient_id, kind, starts_at, ends_at, area, message, url, status, expires_at, created_at)
         SELECT ?6, ?1, ?2, ?7, ?3, ?4, ?8, ?9, ?10, 'pending', ?11, ?5
         WHERE ${MUTUAL_FRIENDS}
           AND NOT ${LIVE_SAME_INVITE}
           AND (SELECT COUNT(*) FROM direct_invites WHERE sender_id = ?1 AND created_at > ?12) < ?13`,
      )
      .bind(
        row.senderId,
        row.recipientId,
        row.startsAt,
        row.endsAt,
        row.now,
        row.id,
        row.kind,
        row.area,
        row.message,
        row.url,
        row.expiresAt,
        limit.since,
        limit.count,
      ),
    d1
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT ?1, 'DirectInviteSent', ?2, ?3 WHERE EXISTS (SELECT 1 FROM direct_invites WHERE id = ?4)`,
      )
      .bind(event.id, event.payload, row.now, row.id),
  ]);
  return inserted?.meta.changes === 1;
}

/** 送信が0行だったときの理由を、判定の順番（404 → 409 → 429）で読み直す */
export async function diagnoseSend(
  d1: D1Database,
  row: { senderId: string; recipientId: string; startsAt: number; endsAt: number; now: number },
  since: number,
) {
  const result = await d1
    .prepare(
      `SELECT
         (${MUTUAL_FRIENDS}) AS friends,
         (${LIVE_SAME_INVITE}) AS duplicate,
         (SELECT COUNT(*) FROM direct_invites WHERE sender_id = ?1 AND created_at > ?6) AS sent,
         (SELECT MIN(created_at) FROM direct_invites WHERE sender_id = ?1 AND created_at > ?6) AS oldest`,
    )
    .bind(row.senderId, row.recipientId, row.startsAt, row.endsAt, row.now, since)
    .first<{ friends: number; duplicate: number; sent: number; oldest: number | null }>();
  return {
    friends: result?.friends === 1,
    duplicate: result?.duplicate === 1,
    sent: result?.sent ?? 0,
    oldest: result?.oldest ?? null,
  };
}

/** 閲覧者が送信者か受信者の誘いだけ */
export async function findInviteFor(d1: D1Database, viewerId: string, id: string) {
  return d1
    .prepare(`SELECT ${INVITE_COLUMNS} FROM direct_invites i WHERE i.id = ?1 AND (i.sender_id = ?2 OR i.recipient_id = ?2)`)
    .bind(id, viewerId)
    .first<InviteRow>();
}

/** 閲覧者が受信者（as = "recipient"）または送信者（as = "sender"）の誘いだけ。返答・決定で使う */
export async function findInviteAs(d1: D1Database, viewerId: string, id: string, as: "recipient" | "sender") {
  const owner = as === "recipient" ? "i.recipient_id" : "i.sender_id";
  return d1
    .prepare(`SELECT ${INVITE_COLUMNS} FROM direct_invites i WHERE i.id = ?1 AND ${owner} = ?2`)
    .bind(id, viewerId)
    .first<InviteRow>();
}

/** 受信・送信の一覧。作成日時の新しい順、同じなら id の降順。limit + 1 件読む */
export async function listInvites(
  d1: D1Database,
  viewerId: string,
  box: "received" | "sent",
  limit: number,
  cursor: { k: number; id: string } | null,
) {
  const owner = box === "received" ? "i.recipient_id" : "i.sender_id";
  const { results } = await d1
    .prepare(
      `SELECT ${INVITE_COLUMNS} FROM direct_invites i
       WHERE ${owner} = ?1 AND (?2 IS NULL OR i.created_at < ?2 OR (i.created_at = ?2 AND i.id < ?3))
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?4`,
    )
    .bind(viewerId, cursor?.k ?? null, cursor?.id ?? "", limit + 1)
    .all<InviteRow>();
  return results;
}

type Event = { id: string; type: string; payload: string };

const outboxIfTransition = (d1: D1Database, table: "direct_invites" | "meetups", rowId: string, tid: string, e: Event, now: number) =>
  d1
    .prepare(
      `INSERT INTO outbox (id, type, payload, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ?5 AND transition_id = ?6)`,
    )
    .bind(e.id, e.type, e.payload, now, rowId, tid);

/** 成立の後続の文：予定・参加者2人・MeetupConfirmed。誘いがこの遷移で confirmed になったときだけ書く */
function meetupStatements(
  d1: D1Database,
  invite: { id: string; senderId: string; recipientId: string },
  meetup: { id: string; startsAt: number; endsAt: number },
  tid: string,
  event: Event,
  now: number,
) {
  return [
    d1
      .prepare(
        `INSERT INTO meetups (id, direct_invite_id, starts_at, ends_at, status, created_at)
         SELECT ?1, ?2, ?3, ?4, 'confirmed', ?5
         WHERE EXISTS (SELECT 1 FROM direct_invites WHERE id = ?2 AND status = 'confirmed' AND transition_id = ?6)`,
      )
      .bind(meetup.id, invite.id, meetup.startsAt, meetup.endsAt, now, tid),
    d1
      .prepare(
        `INSERT INTO meetup_participants (meetup_id, user_id)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM meetups WHERE id = ?1)
         UNION ALL
         SELECT ?1, ?3 WHERE EXISTS (SELECT 1 FROM meetups WHERE id = ?1)`,
      )
      .bind(meetup.id, invite.senderId, invite.recipientId),
    d1
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT ?1, 'MeetupConfirmed', ?2, ?3 WHERE EXISTS (SELECT 1 FROM meetups WHERE id = ?4)`,
      )
      .bind(event.id, event.payload, now, meetup.id),
  ];
}

type InviteRef = { id: string; senderId: string; recipientId: string };

/** 返答の「行く」。pending で期限前のときだけ confirmed にし、予定を作る。遷移できたら true */
export async function acceptInvite(
  d1: D1Database,
  invite: InviteRef & { startsAt: number; endsAt: number },
  meetupId: string,
  event: Event,
  now: number,
) {
  const tid = crypto.randomUUID();
  const [updated] = await d1.batch([
    d1
      .prepare(
        `UPDATE direct_invites SET status = 'confirmed', responded_at = ?1, transition_id = ?2
         WHERE id = ?3 AND recipient_id = ?4 AND status = 'pending' AND expires_at > ?1`,
      )
      .bind(now, tid, invite.id, invite.recipientId),
    ...meetupStatements(d1, invite, { id: meetupId, startsAt: invite.startsAt, endsAt: invite.endsAt }, tid, event, now),
  ]);
  return updated?.meta.changes === 1;
}

/** 返答の「今回は難しい」「この時間なら」。遷移できたら true */
export async function respondInvite(
  d1: D1Database,
  invite: InviteRef,
  next: { status: "declined" } | { status: "counter_proposed"; startsAt: number; endsAt: number },
  event: Event,
  now: number,
) {
  const tid = crypto.randomUUID();
  const counter = next.status === "counter_proposed" ? next : null;
  const [updated] = await d1.batch([
    d1
      .prepare(
        `UPDATE direct_invites
         SET status = ?1, counter_starts_at = ?2, counter_ends_at = ?3, responded_at = ?4, transition_id = ?5
         WHERE id = ?6 AND recipient_id = ?7 AND status = 'pending' AND expires_at > ?4`,
      )
      .bind(next.status, counter?.startsAt ?? null, counter?.endsAt ?? null, now, tid, invite.id, invite.recipientId),
    outboxIfTransition(d1, "direct_invites", invite.id, tid, event, now),
  ]);
  return updated?.meta.changes === 1;
}

/** 決定の「決める」。counter_proposed で代わりの時間の開始前のときだけ、代わりの時間で予定を作る */
export async function decideAccept(
  d1: D1Database,
  invite: InviteRef & { counterStartsAt: number; counterEndsAt: number },
  meetupId: string,
  event: Event,
  now: number,
) {
  const tid = crypto.randomUUID();
  const [updated] = await d1.batch([
    d1
      .prepare(
        `UPDATE direct_invites SET status = 'confirmed', decided_at = ?1, transition_id = ?2
         WHERE id = ?3 AND sender_id = ?4 AND status = 'counter_proposed' AND counter_starts_at > ?1`,
      )
      .bind(now, tid, invite.id, invite.senderId),
    ...meetupStatements(
      d1,
      invite,
      { id: meetupId, startsAt: invite.counterStartsAt, endsAt: invite.counterEndsAt },
      tid,
      event,
      now,
    ),
  ]);
  return updated?.meta.changes === 1;
}

/** 決定の「見送る」 */
export async function decideSkip(d1: D1Database, invite: InviteRef, event: Event, now: number) {
  const tid = crypto.randomUUID();
  const [updated] = await d1.batch([
    d1
      .prepare(
        `UPDATE direct_invites SET status = 'skipped', decided_at = ?1, transition_id = ?2
         WHERE id = ?3 AND sender_id = ?4 AND status = 'counter_proposed' AND counter_starts_at > ?1`,
      )
      .bind(now, tid, invite.id, invite.senderId),
    outboxIfTransition(d1, "direct_invites", invite.id, tid, event, now),
  ]);
  return updated?.meta.changes === 1;
}

const MEETUP_COLUMNS = `m.id, m.direct_invite_id, m.starts_at, m.ends_at, m.status, m.created_at,
  i.area, i.message, i.url`;

/** 閲覧者が参加者の予定だけ */
export async function findMeetupFor(d1: D1Database, viewerId: string, id: string) {
  return d1
    .prepare(
      `SELECT ${MEETUP_COLUMNS} FROM meetups m
       JOIN meetup_participants p ON p.meetup_id = m.id AND p.user_id = ?2
       LEFT JOIN direct_invites i ON i.id = m.direct_invite_id
       WHERE m.id = ?1`,
    )
    .bind(id, viewerId)
    .first<MeetupRow>();
}

/** これからの成立した予定。開始日時の古い順、同じなら id の昇順。limit + 1 件読む */
export async function listMeetups(
  d1: D1Database,
  viewerId: string,
  now: number,
  limit: number,
  cursor: { k: number; id: string } | null,
) {
  const { results } = await d1
    .prepare(
      `SELECT ${MEETUP_COLUMNS} FROM meetups m
       JOIN meetup_participants p ON p.meetup_id = m.id AND p.user_id = ?1
       LEFT JOIN direct_invites i ON i.id = m.direct_invite_id
       WHERE m.status = 'confirmed' AND m.ends_at > ?2
         AND (?3 IS NULL OR m.starts_at > ?3 OR (m.starts_at = ?3 AND m.id > ?4))
       ORDER BY m.starts_at, m.id LIMIT ?5`,
    )
    .bind(viewerId, now, cursor?.k ?? null, cursor?.id ?? "", limit + 1)
    .all<MeetupRow>();
  return results;
}

/** 予定ごとの参加者のID */
export async function participantsOf(d1: D1Database, meetupIds: string[]) {
  const map = new Map<string, string[]>();
  for (let i = 0; i < meetupIds.length; i += 90) {
    const ids = meetupIds.slice(i, i + 90);
    const { results } = await d1
      .prepare(
        `SELECT meetup_id, user_id FROM meetup_participants
         WHERE meetup_id IN (${ids.map((_, j) => `?${j + 1}`).join(", ")})`,
      )
      .bind(...ids)
      .all<{ meetup_id: string; user_id: string }>();
    for (const r of results) {
      const list = map.get(r.meetup_id) ?? [];
      list.push(r.user_id);
      map.set(r.meetup_id, list);
    }
  }
  return map;
}

/** 「やっぱり難しい」。参加者で、confirmed で開始前のときだけ。元の誘いも同じ batch で cancelled にする */
export async function cancelMeetup(d1: D1Database, viewerId: string, meetupId: string, event: Event, now: number) {
  const tid = crypto.randomUUID();
  const [updated] = await d1.batch([
    d1
      .prepare(
        `UPDATE meetups SET status = 'cancelled', cancelled_at = ?1, transition_id = ?2
         WHERE id = ?3 AND status = 'confirmed' AND starts_at > ?1
           AND EXISTS (SELECT 1 FROM meetup_participants WHERE meetup_id = ?3 AND user_id = ?4)`,
      )
      .bind(now, tid, meetupId, viewerId),
    d1
      .prepare(
        `UPDATE direct_invites SET status = 'cancelled', transition_id = ?1
         WHERE status = 'confirmed'
           AND id = (SELECT direct_invite_id FROM meetups WHERE id = ?2 AND transition_id = ?1)`,
      )
      .bind(tid, meetupId),
    outboxIfTransition(d1, "meetups", meetupId, tid, event, now),
  ]);
  return updated?.meta.changes === 1;
}
