import type { StoredBroadcastStatus } from "../domain/broadcast";
import { oldestSentSql, sentCountSql } from "./repository";

// 募集の永続化（docs/specs/T-05-broadcast.md「データ」「振る舞い」）
// 宛先のIDは JSON の配列1つで渡し、json_each で展開する（D1 の1つの文に渡せる値は100個まで）
// 状態遷移は条件付き UPDATE。同じ batch の後続の文は transition_id を EXISTS で確かめて書く

export type BroadcastRow = {
  id: string;
  owner_id: string;
  starts_at: number;
  ends_at: number;
  area: string | null;
  message: string | null;
  url: string | null;
  status: StoredBroadcastStatus;
  expires_at: number;
  created_at: number;
  /** 今応じている宛先の数（application は募集者にだけ返す） */
  responding: number;
  /** 閲覧者自身が応じた時刻（宛先でなければ null） */
  my_responded_at: number | null;
  meetup_id: string | null;
  /** 予定の参加者の数（抜けた人を含む） */
  participant_count: number;
  /** 閲覧者が予定の参加者か（抜けた人を含む） */
  is_participant: number;
};

/** ?1 閲覧者 */
const BROADCAST_COLUMNS = `b.id, b.owner_id, b.starts_at, b.ends_at, b.area, b.message, b.url, b.status, b.expires_at,
  b.created_at,
  (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.responded_at IS NOT NULL) AS responding,
  mine.responded_at AS my_responded_at,
  m.id AS meetup_id,
  (SELECT COUNT(*) FROM meetup_participants p WHERE p.meetup_id = m.id) AS participant_count,
  EXISTS (SELECT 1 FROM meetup_participants p WHERE p.meetup_id = m.id AND p.user_id = ?1) AS is_participant`;

const BROADCAST_JOINS = `LEFT JOIN broadcast_recipients mine ON mine.broadcast_id = b.id AND mine.user_id = ?1
  LEFT JOIN meetups m ON m.broadcast_id = b.id`;

/** 宛先の全員と、閲覧者の間に両方向の友達関係の行がそろっているか（?O 募集者、?R 宛先の JSON 配列） */
const allFriendsSql = (o: number, r: number) =>
  `(SELECT COUNT(*) FROM json_each(?${r}) j
     WHERE EXISTS (SELECT 1 FROM friendships WHERE user_id = ?${o} AND friend_id = j.value)
       AND EXISTS (SELECT 1 FROM friendships WHERE user_id = j.value AND friend_id = ?${o})) = json_array_length(?${r})`;

export type NewBroadcast = {
  id: string;
  ownerId: string;
  recipientIds: string[];
  startsAt: number;
  endsAt: number;
  area: string | null;
  message: string | null;
  url: string | null;
  expiresAt: number;
  now: number;
};

/**
 * 宛先全員が友達であることと送信上限を、追加と同じ batch で判定して書く。宛先の行と、宛先ごとの BroadcastSent は
 * 募集の行があるときだけ書く。追加できたら true
 */
export async function insertBroadcast(d1: D1Database, row: NewBroadcast, limit: { count: number; since: number }) {
  const recipients = JSON.stringify(row.recipientIds);
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO broadcasts (id, owner_id, starts_at, ends_at, area, message, url, status, expires_at, created_at)
         SELECT ?3, ?1, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10
         WHERE ${allFriendsSql(1, 2)} AND ${sentCountSql(1, 11)} < ?12`,
      )
      .bind(
        row.ownerId,
        recipients,
        row.id,
        row.startsAt,
        row.endsAt,
        row.area,
        row.message,
        row.url,
        row.expiresAt,
        row.now,
        limit.since,
        limit.count,
      ),
    d1
      .prepare(
        `INSERT INTO broadcast_recipients (broadcast_id, user_id, created_at)
         SELECT ?1, j.value, ?3 FROM json_each(?2) j WHERE EXISTS (SELECT 1 FROM broadcasts WHERE id = ?1)`,
      )
      .bind(row.id, recipients, row.now),
    // payload は T-04 と同じく受け取り手1人の形。行ごとの id は SQL の乱数で作る（outbox の id は一意であればよい）
    d1
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT lower(hex(randomblob(16))),
           'BroadcastSent',
           json_object('userId', r.user_id, 'broadcastId', ?1, 'actorId', ?2, 'occurredAt', ?3), ?4
         FROM broadcast_recipients r WHERE r.broadcast_id = ?1`,
      )
      .bind(row.id, row.ownerId, new Date(row.now).toISOString(), row.now),
  ]);
  return inserted?.meta.changes === 1;
}

/** 作成が0行だったときの理由を、判定の順番（404 → 429）で読み直す */
export async function diagnoseBroadcast(
  d1: D1Database,
  row: { ownerId: string; recipientIds: string[] },
  since: number,
) {
  const result = await d1
    .prepare(
      `SELECT (${allFriendsSql(1, 2)}) AS friends, ${sentCountSql(1, 3)} AS sent, ${oldestSentSql(1, 3)} AS oldest`,
    )
    .bind(row.ownerId, JSON.stringify(row.recipientIds), since)
    .first<{ friends: number; sent: number; oldest: number | null }>();
  return {
    friends: result?.friends === 1,
    duplicate: false,
    sent: result?.sent ?? 0,
    oldest: result?.oldest ?? null,
  };
}

/** 閲覧者が募集者か宛先の募集だけ */
export async function findBroadcastFor(d1: D1Database, viewerId: string, id: string) {
  return d1
    .prepare(
      `SELECT ${BROADCAST_COLUMNS} FROM broadcasts b ${BROADCAST_JOINS}
       WHERE b.id = ?2 AND (b.owner_id = ?1 OR mine.user_id IS NOT NULL)`,
    )
    .bind(viewerId, id)
    .first<BroadcastRow>();
}

/** 自分の募集（sent）・受け取った募集（received）。作成日時の新しい順、同じなら id の降順。limit + 1 件読む */
export async function listBroadcasts(
  d1: D1Database,
  viewerId: string,
  box: "received" | "sent",
  limit: number,
  cursor: { k: number; id: string } | null,
) {
  const owner = box === "sent" ? "b.owner_id = ?1" : "mine.user_id IS NOT NULL";
  const { results } = await d1
    .prepare(
      `SELECT ${BROADCAST_COLUMNS} FROM broadcasts b ${BROADCAST_JOINS}
       WHERE ${owner} AND (?2 IS NULL OR b.created_at < ?2 OR (b.created_at = ?2 AND b.id < ?3))
       ORDER BY b.created_at DESC, b.id DESC LIMIT ?4`,
    )
    .bind(viewerId, cursor?.k ?? null, cursor?.id ?? "", limit + 1)
    .all<BroadcastRow>();
  return results;
}

/** 募集ごとの宛先のID（募集者の一覧・詳細だけで使う） */
export async function recipientsOf(d1: D1Database, broadcastIds: string[]) {
  const map = new Map<string, string[]>();
  if (broadcastIds.length === 0) return map;
  const { results } = await d1
    .prepare(
      `SELECT broadcast_id, user_id FROM broadcast_recipients
       WHERE broadcast_id IN (SELECT value FROM json_each(?1)) ORDER BY created_at, user_id`,
    )
    .bind(JSON.stringify(broadcastIds))
    .all<{ broadcast_id: string; user_id: string }>();
  for (const r of results) {
    const list = map.get(r.broadcast_id) ?? [];
    list.push(r.user_id);
    map.set(r.broadcast_id, list);
  }
  return map;
}

/** この募集の予定の参加者でないこと（?1 募集、?2 閲覧者） */
const NOT_PARTICIPANT = `NOT EXISTS (SELECT 1 FROM meetups m JOIN meetup_participants p ON p.meetup_id = m.id
                                     WHERE m.broadcast_id = ?1 AND p.user_id = ?2)`;

/**
 * 応じる（respond = true）・やめる。宛先で、予定の参加者でなく、期限前のときだけ（決めた後でも受け付ける。
 * 決定事項6）。行が更新されたら true（すでに応じている・応じていないときも true）
 */
export async function setResponse(d1: D1Database, broadcastId: string, viewerId: string, respond: boolean, now: number) {
  const result = await d1
    .prepare(
      `UPDATE broadcast_recipients SET responded_at = ${respond ? "COALESCE(responded_at, ?3)" : "NULL"}
       WHERE broadcast_id = ?1 AND user_id = ?2
         AND EXISTS (SELECT 1 FROM broadcasts WHERE id = ?1 AND expires_at > ?3)
         AND ${NOT_PARTICIPANT}`,
    )
    .bind(broadcastId, viewerId, now)
    .run();
  return result.meta.changes === 1;
}

/**
 * 決める。募集者で、open で期限前、応じている人が1人以上のときだけ decided にし、予定と参加者（募集者と、
 * この batch の時点で応じている人全員）、BroadcastDecided・MeetupConfirmed を書く。participantIds は SQL の中で作る
 */
export async function decideBroadcast(
  d1: D1Database,
  ownerId: string,
  broadcastId: string,
  ids: { meetupId: string; decidedEventId: string; confirmedEventId: string },
  now: number,
) {
  const tid = crypto.randomUUID();
  const occurredAt = new Date(now).toISOString();
  const participantIds = `json((SELECT json_group_array(user_id) FROM meetup_participants WHERE meetup_id = ?1))`;
  const [updated] = await d1.batch([
    d1
      .prepare(
        `UPDATE broadcasts SET status = 'decided', decided_at = ?1, transition_id = ?2
         WHERE id = ?3 AND owner_id = ?4 AND status = 'open' AND expires_at > ?1
           AND EXISTS (SELECT 1 FROM broadcast_recipients WHERE broadcast_id = ?3 AND responded_at IS NOT NULL)`,
      )
      .bind(now, tid, broadcastId, ownerId),
    d1
      .prepare(
        `INSERT INTO meetups (id, broadcast_id, starts_at, ends_at, status, created_at)
         SELECT ?1, id, starts_at, ends_at, 'confirmed', ?2 FROM broadcasts WHERE id = ?3 AND transition_id = ?4`,
      )
      .bind(ids.meetupId, now, broadcastId, tid),
    d1
      .prepare(
        `INSERT INTO meetup_participants (meetup_id, user_id)
         SELECT ?1, owner_id FROM broadcasts WHERE id = ?2 AND EXISTS (SELECT 1 FROM meetups WHERE id = ?1)
         UNION ALL
         SELECT ?1, user_id FROM broadcast_recipients
         WHERE broadcast_id = ?2 AND responded_at IS NOT NULL AND EXISTS (SELECT 1 FROM meetups WHERE id = ?1)`,
      )
      .bind(ids.meetupId, broadcastId),
    d1
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT ?2, 'BroadcastDecided',
           json_object('meetupId', ?1, 'broadcastId', ?3, 'participantIds', ${participantIds}, 'occurredAt', ?4), ?5
         WHERE EXISTS (SELECT 1 FROM meetups WHERE id = ?1)`,
      )
      .bind(ids.meetupId, ids.decidedEventId, broadcastId, occurredAt, now),
    d1
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT ?2, 'MeetupConfirmed',
           json_object('meetupId', ?1, 'inviteId', NULL, 'broadcastId', ?3, 'participantIds', ${participantIds},
                       'occurredAt', ?4), ?5
         WHERE EXISTS (SELECT 1 FROM meetups WHERE id = ?1)`,
      )
      .bind(ids.meetupId, ids.confirmedEventId, broadcastId, occurredAt, now),
  ]);
  return updated?.meta.changes === 1;
}
