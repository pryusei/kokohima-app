import type { Category, Draft, NotificationKind } from "../domain/kinds";

// notification のD1アクセス（docs/specs/T-07-notification.md「データ」）
// お知らせ・設定・購読は、必ず user_id で絞る

export type NotificationRow = {
  id: string;
  user_id: string;
  kind: NotificationKind;
  actor_id: string | null;
  subject_id: string | null;
  count: number | null;
  device: string | null;
  event_id: string;
  created_at: number;
  inserted_at: number;
  read_at: number | null;
  channel: "push" | "email" | "none" | null;
  counted_push_at: number | null;
  counted_email_at: number | null;
  delivered_at: number | null;
  outcome: string | null;
};

export type Channel = "push" | "email";
export type Outcome = "sent" | "muted" | "limited" | "no_address" | "failed";

// ---- お知らせを作る ----

/**
 * 受け取り手ごとに1件。同じイベントが2回届いても1件（event_id と user_id が一意）。退会した人には書かない。
 * まだ届け終えていない（delivered_at が NULL の）お知らせの ID を返す
 */
export async function insertDrafts(
  d1: D1Database,
  eventId: string,
  drafts: Draft[],
  occurredAt: number,
  now: number,
): Promise<string[]> {
  if (drafts.length === 0) return [];
  const rows = drafts.map((d) => ({ id: crypto.randomUUID(), ...d }));
  const [, pending] = await d1.batch<{ id: string }>([
    d1
      .prepare(
        `INSERT OR IGNORE INTO notifications
           (id, user_id, kind, actor_id, subject_id, count, device, event_id, created_at, inserted_at)
         SELECT json_extract(r.value, '$.id'), json_extract(r.value, '$.userId'), json_extract(r.value, '$.kind'),
           json_extract(r.value, '$.actorId'), json_extract(r.value, '$.subjectId'), json_extract(r.value, '$.count'),
           json_extract(r.value, '$.device'), ?2, ?3, ?4
         FROM json_each(?1) r
         WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = json_extract(r.value, '$.userId'))`,
      )
      .bind(JSON.stringify(rows), eventId, occurredAt, now),
    d1
      .prepare(
        `SELECT id FROM notifications
         WHERE event_id = ?1 AND delivered_at IS NULL AND user_id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(eventId, JSON.stringify(drafts.map((d) => d.userId))),
  ]);
  return (pending?.results ?? []).map((r) => r.id);
}

export async function findNotification(d1: D1Database, id: string) {
  return d1.prepare("SELECT * FROM notifications WHERE id = ?1").bind(id).first<NotificationRow>();
}

/** 届け終えた（または送らないと決めた）印を付ける。まだ付いていないときだけ */
export async function markDelivered(d1: D1Database, id: string, channel: Channel | "none", outcome: Outcome, now: number) {
  await d1
    .prepare(
      "UPDATE notifications SET delivered_at = ?2, channel = ?3, outcome = ?4 WHERE id = ?1 AND delivered_at IS NULL",
    )
    .bind(id, now, channel, outcome)
    .run();
}

// ---- 1日の数 ----

/**
 * 利用者の1日の数を1つ増やし、上限に収まったかを返す。お知らせがそのチャネルでまだ数えられていないときだけ
 * 増やす（再試行で二重に数えない）。すでに数えていれば true
 */
export async function countWithinLimit(
  d1: D1Database,
  n: { id: string; userId: string },
  channel: Channel,
  day: string,
  limit: number,
  now: number,
): Promise<boolean> {
  // 列の名前は固定の2つから選ぶ（利用者の値は入らない）
  const column = channel === "push" ? "counted_push_at" : "counted_email_at";
  const already = await d1
    .prepare(`SELECT ${column} AS counted FROM notifications WHERE id = ?1`)
    .bind(n.id)
    .first<{ counted: number | null }>();
  if (!already) return false;
  if (already.counted !== null) return true;
  const [marked, counted] = await d1.batch([
    d1.prepare(`UPDATE notifications SET ${column} = ?2 WHERE id = ?1 AND ${column} IS NULL`).bind(n.id, now),
    d1
      .prepare(
        `INSERT INTO notification_daily_counts (user_id, day, channel, count)
         SELECT ?1, ?2, ?3, 1 WHERE changes() = 1
         ON CONFLICT (user_id, day, channel) DO UPDATE SET count = count + 1 WHERE count < ?4`,
      )
      .bind(n.userId, day, channel, limit),
  ]);
  // 同時に別の処理が数えた（印が0行）なら、上限の中として扱う
  if (marked?.meta.changes !== 1) return true;
  return counted?.meta.changes === 1;
}

/**
 * サービス全体の1日のメールの数（user_id が '' の行）を1つ増やし、上限に収まったかを返す。
 * お知らせごとに1回だけ数える（'n:<id>' の印の行があれば、すでに数えた）
 */
export async function claimGlobalEmailCount(d1: D1Database, id: string, day: string, limit: number): Promise<boolean> {
  const [claimed, counted] = await d1.batch([
    d1
      .prepare(
        "INSERT OR IGNORE INTO notification_daily_counts (user_id, day, channel, count) VALUES (?1, ?2, 'email_claim', 1)",
      )
      .bind(`n:${id}`, day),
    d1
      .prepare(
        `INSERT INTO notification_daily_counts (user_id, day, channel, count)
         SELECT '', ?1, 'email', 1 WHERE changes() = 1
         ON CONFLICT (user_id, day, channel) DO UPDATE SET count = count + 1 WHERE count < ?2`,
      )
      .bind(day, limit),
  ]);
  // すでに数えていれば（claim が0行）、上限の中として扱う
  if (claimed?.meta.changes !== 1) return true;
  return counted?.meta.changes === 1;
}

export async function deleteOldCounts(d1: D1Database, beforeDay: string) {
  await d1.prepare("DELETE FROM notification_daily_counts WHERE day < ?1").bind(beforeDay).run();
}

export async function deleteOldNotifications(d1: D1Database, before: number) {
  await d1.prepare("DELETE FROM notifications WHERE inserted_at < ?1").bind(before).run();
}

// ---- 一覧・既読 ----

/** 自分のお知らせ。行を作った時刻の新しい順、同じなら id の降順。limit + 1 件読む */
export async function listNotifications(
  d1: D1Database,
  viewerId: string,
  limit: number,
  cursor: { k: number; id: string } | null,
) {
  const { results } = await d1
    .prepare(
      `SELECT * FROM notifications
       WHERE user_id = ?1 AND (?2 IS NULL OR inserted_at < ?2 OR (inserted_at = ?2 AND id < ?3))
       ORDER BY inserted_at DESC, id DESC LIMIT ?4`,
    )
    .bind(viewerId, cursor?.k ?? null, cursor?.id ?? "", limit + 1)
    .all<NotificationRow>();
  return results;
}

/** 未読の数（上限つき） */
export async function countUnread(d1: D1Database, viewerId: string, cap: number) {
  const row = await d1
    .prepare(
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM notifications WHERE user_id = ?1 AND read_at IS NULL LIMIT ?2)",
    )
    .bind(viewerId, cap)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * upTo のお知らせ以前（inserted_at と id の順）に作られた自分のお知らせを既読にする。
 * upTo が自分のお知らせでなければ false
 */
export async function markReadUpTo(d1: D1Database, viewerId: string, upTo: string, now: number) {
  const anchor = await d1
    .prepare("SELECT inserted_at FROM notifications WHERE id = ?1 AND user_id = ?2")
    .bind(upTo, viewerId)
    .first<{ inserted_at: number }>();
  if (!anchor) return false;
  await d1
    .prepare(
      `UPDATE notifications SET read_at = ?4
       WHERE user_id = ?1 AND read_at IS NULL AND (inserted_at < ?2 OR (inserted_at = ?2 AND id <= ?3))`,
    )
    .bind(viewerId, anchor.inserted_at, upTo, now)
    .run();
  return true;
}

// ---- 設定 ----

export type PreferenceRow = Record<Category, number>;

export async function getPreferences(d1: D1Database, userId: string) {
  return d1
    .prepare("SELECT invites, broadcasts, meetups, friends, calendar FROM notification_preferences WHERE user_id = ?1")
    .bind(userId)
    .first<PreferenceRow>();
}

export async function putPreferences(d1: D1Database, userId: string, p: Record<Category, boolean>, now: number) {
  await d1
    .prepare(
      `INSERT INTO notification_preferences (user_id, invites, broadcasts, meetups, friends, calendar, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (user_id) DO UPDATE SET invites = ?2, broadcasts = ?3, meetups = ?4, friends = ?5, calendar = ?6,
         updated_at = ?7`,
    )
    .bind(userId, +p.invites, +p.broadcasts, +p.meetups, +p.friends, +p.calendar, now)
    .run();
}

// ---- プッシュの購読 ----

export const MAX_SUBSCRIPTIONS = 10;

export type SubscriptionRow = { id: string; user_id: string; session_id: string; endpoint_enc: string };

/**
 * 購読を登録する。同じ endpoint があれば（別の人の行でも）閲覧者とセッションに付け替える。
 * 上限を超えたら、いちばん古い購読を消して入れ替える
 */
export async function upsertSubscription(
  d1: D1Database,
  row: { userId: string; sessionId: string; endpointHash: string; endpointEnc: string; now: number },
) {
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint_hash, endpoint_enc, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (endpoint_hash) DO UPDATE SET user_id = ?2, session_id = ?3, endpoint_enc = ?5`,
      )
      .bind(crypto.randomUUID(), row.userId, row.sessionId, row.endpointHash, row.endpointEnc, row.now),
    d1
      .prepare(
        `DELETE FROM push_subscriptions WHERE user_id = ?1 AND id NOT IN (
           SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)`,
      )
      .bind(row.userId, MAX_SUBSCRIPTIONS),
  ]);
}

/** 自分の購読だけを消す（なくても何もしない） */
export async function deleteSubscription(d1: D1Database, userId: string, endpointHash: string) {
  await d1.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint_hash = ?2").bind(userId, endpointHash).run();
}

export async function deleteSubscriptionById(d1: D1Database, id: string) {
  await d1.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(id).run();
}

export async function deleteSubscriptionsOfSession(d1: D1Database, sessionId: string) {
  await d1.prepare("DELETE FROM push_subscriptions WHERE session_id = ?1").bind(sessionId).run();
}

export async function deleteSubscriptionsOfUser(d1: D1Database, userId: string) {
  await d1.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1").bind(userId).run();
}

/** その人の購読（古い順） */
export async function subscriptionsOf(d1: D1Database, userId: string) {
  const { results } = await d1
    .prepare("SELECT id, user_id, session_id, endpoint_enc FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at, id")
    .bind(userId)
    .all<SubscriptionRow>();
  return results;
}

export async function hasSubscription(d1: D1Database, userId: string) {
  const row = await d1.prepare("SELECT 1 AS x FROM push_subscriptions WHERE user_id = ?1 LIMIT 1").bind(userId).first();
  return row !== null;
}

export async function markSubscriptionSuccess(d1: D1Database, id: string, now: number) {
  await d1.prepare("UPDATE push_subscriptions SET last_success_at = ?2 WHERE id = ?1").bind(id, now).run();
}
