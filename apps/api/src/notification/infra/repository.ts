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
         WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = json_extract(r.value, '$.userId') AND u.withdrawn_at IS NULL)`,
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
 * 利用者の1日の数（`counter` の行）を1つ増やし、上限に収まったかを返す。
 * 数えられたときだけ、お知らせにそのチャネルの印（`counted_*_at`）を付ける。印があれば、すでに数えた（再試行）として true。
 * 上限に達して数えられなかったときは印を付けないので、再試行でももう一度上限で確かめる
 */
export async function countWithinLimit(
  d1: D1Database,
  n: { id: string; userId: string },
  channel: Channel,
  counter: string,
  day: string,
  limit: number,
  now: number,
): Promise<boolean> {
  // 列の名前は固定の2つから選ぶ（利用者の値は入らない）
  const column = channel === "push" ? "counted_push_at" : "counted_email_at";
  const readMark = async () =>
    (
      await d1
        .prepare(`SELECT ${column} AS counted FROM notifications WHERE id = ?1`)
        .bind(n.id)
        .first<{ counted: number | null }>()
    )?.counted ?? null;
  if ((await readMark()) !== null) return true;
  const [, marked] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO notification_daily_counts (user_id, day, channel, count)
         SELECT ?1, ?2, ?3, 1 WHERE EXISTS (SELECT 1 FROM notifications WHERE id = ?5 AND ${column} IS NULL)
         ON CONFLICT (user_id, day, channel) DO UPDATE SET count = count + 1 WHERE count < ?4`,
      )
      .bind(n.userId, day, counter, limit, n.id),
    // 直前の文で数えられたときだけ印を付ける
    d1.prepare(`UPDATE notifications SET ${column} = ?2 WHERE id = ?1 AND ${column} IS NULL AND changes() = 1`).bind(n.id, now),
  ]);
  if (marked?.meta.changes === 1) return true;
  // 数えられなかった：上限に達したか、同時に別の処理が数えた（印が付いていれば、そちらで数えた）
  return (await readMark()) !== null;
}

/**
 * サービス全体の1日のメールの数（user_id が '' の行。day は UTC の日付）を1つ増やし、上限に収まったかを返す。
 * limit が null なら上限なしで数える（新端末のログイン）。
 * お知らせごとに1回だけ数える（'n:<id>' の印の行があれば、すでに数えた）。上限で止まったときも印は残すので、
 * 同じ日のうちの再試行では「数えた」として送る側に倒れない（印を消して数え直す）
 */
export async function claimGlobalEmailCount(d1: D1Database, id: string, day: string, limit: number | null): Promise<boolean> {
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
         ON CONFLICT (user_id, day, channel) DO UPDATE SET count = count + 1 WHERE ?2 IS NULL OR count < ?2`,
      )
      .bind(day, limit),
  ]);
  // すでに数えていれば（claim が0行）、上限の中として扱う
  if (claimed?.meta.changes !== 1) return true;
  if (counted?.meta.changes === 1) return true;
  // 上限で止まった：印を消し、再試行でも同じく上限で確かめる
  await d1
    .prepare("DELETE FROM notification_daily_counts WHERE user_id = ?1 AND day = ?2 AND channel = 'email_claim'")
    .bind(`n:${id}`, day)
    .run();
  return false;
}

export async function deleteOldCounts(d1: D1Database, beforeDay: string) {
  await d1.prepare("DELETE FROM notification_daily_counts WHERE day < ?1").bind(beforeDay).run();
}

/** 作ったのが before より前のお知らせを消す（上限つき。インデックス notifications_inserted）。消した数 */
export async function deleteOldNotifications(d1: D1Database, before: number, limit: number) {
  const r = await d1
    .prepare("DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE inserted_at < ?1 LIMIT ?2)")
    .bind(before, limit)
    .run();
  return r.meta.changes;
}

/**
 * 失効か期限切れのセッションの購読を消す（上限つき。docs/specs/T-17-retention.md「9.」）。
 * セッションの掃除は利用者ごとに最初のセッションの行を残すので、その行の購読も CASCADE では消えない。消した数。
 * CROSS JOIN は内部結合と同じ結果で、sessions を外側に固定する（sessions_revoked_at・sessions_expires_at の MULTI-INDEX OR で絞り、
 * 購読は push_subscriptions_session で引く。JOIN のままだと、統計のない表では購読の表全体を読む計画になる）。
 * 失効は `revoked_at <= now`（失効の時刻は書いた時点の今なので IS NOT NULL と同じ行。IS NOT NULL は OR の中でインデックスを使えない）
 */
export async function deleteSubscriptionsOfDeadSessions(d1: D1Database, now: number, limit: number) {
  const r = await d1
    .prepare(
      `DELETE FROM push_subscriptions WHERE id IN (
         SELECT p.id FROM sessions s CROSS JOIN push_subscriptions p ON p.session_id = s.id
         WHERE s.revoked_at <= ?1 OR s.expires_at <= ?1
         LIMIT ?2
       )`,
    )
    .bind(now, limit)
    .run();
  return r.meta.changes;
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
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND withdrawn_at IS NULL)
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
 * 購読を登録する。同じ endpoint があれば（別の人の行でも）閲覧者とセッションに付け替え、登録の時刻を今にする。
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
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND withdrawn_at IS NULL)
         ON CONFLICT (endpoint_hash) DO UPDATE SET user_id = ?2, session_id = ?3, endpoint_enc = ?5, created_at = ?6`,
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

/** 退会（T-16 入口を止める段）：本人の購読・設定・日ごとの数・本人あてのお知らせを消す文 */
export function withdrawalPurgeStatements(d1: D1Database, userId: string): D1PreparedStatement[] {
  return [
    d1.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").bind(userId),
    d1.prepare("DELETE FROM notification_preferences WHERE user_id = ?").bind(userId),
    d1.prepare("DELETE FROM notification_daily_counts WHERE user_id = ?").bind(userId),
    d1.prepare("DELETE FROM notifications WHERE user_id = ?").bind(userId),
  ];
}
