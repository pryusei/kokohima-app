// calendar のD1アクセス（docs/specs/T-06-calendar.md「データ」）
// 連携の行は必ず user_id で絞る。状態の変化は条件付き UPDATE で行う

export type ConnectionStatus = "active" | "needs_reauth" | "disconnected";
export type Provider = "google";

export type ConnectionRow = {
  user_id: string;
  provider: Provider;
  status: ConnectionStatus;
  refresh_token_enc: string | null;
  calendar_id: string | null;
  connected_at: number;
  updated_at: number;
  busy_snapshot: string | null;
  snapshot_from: number | null;
  snapshot_to: number | null;
  last_synced_at: number | null;
  sync_id: string | null;
  sync_lease_until: number | null;
  large_change_held: number;
  /** 休眠にした時刻（NULL なら休眠でない。docs/specs/T-17-retention.md「8.」） */
  dormant_since: number | null;
};

export async function findConnection(d1: D1Database, userId: string, provider: Provider) {
  return d1
    .prepare("SELECT * FROM calendar_connections WHERE user_id = ?1 AND provider = ?2")
    .bind(userId, provider)
    .first<ConnectionRow>();
}

/** 退会していない人（T-16）の連携だけ。Google を呼ぶ読み取り（カレンダーの空き）で使う */
export async function findConnectionOfActiveUser(d1: D1Database, userId: string, provider: Provider) {
  return d1
    .prepare(
      `SELECT * FROM calendar_connections
       WHERE user_id = ?1 AND provider = ?2
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)`,
    )
    .bind(userId, provider)
    .first<ConnectionRow>();
}

// ---- 連携の開始とコールバック ----

/** 直近の行が limit 未満のときだけ足す。足せたら true（使った行も数える） */
export async function insertOauthStateWithinLimit(
  d1: D1Database,
  row: { stateHash: string; bindingHash: string; userId: string; provider: Provider; codeVerifier: string; now: number },
  ttl: number,
  limit: number,
) {
  const result = await d1
    .prepare(
      `INSERT INTO calendar_oauth_states (state_hash, binding_hash, user_id, provider, code_verifier, expires_at, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE (SELECT COUNT(*) FROM calendar_oauth_states WHERE user_id = ?3 AND created_at > ?8) < ?9
         AND EXISTS (SELECT 1 FROM users WHERE id = ?3 AND withdrawn_at IS NULL)`,
    )
    .bind(row.stateHash, row.bindingHash, row.userId, row.provider, row.codeVerifier, row.now + ttl, row.now, row.now - ttl, limit)
    .run();
  return result.meta.changes === 1;
}

/** 直近の行のうち、いちばん古い作成日時（Retry-After の元） */
export async function oldestOauthState(d1: D1Database, userId: string, since: number) {
  const row = await d1
    .prepare("SELECT MIN(created_at) AS oldest FROM calendar_oauth_states WHERE user_id = ?1 AND created_at > ?2")
    .bind(userId, since)
    .first<{ oldest: number | null }>();
  return row?.oldest ?? null;
}

/** 期限内で未使用の state を、使ったことにして取り出す（同じ state は2回使えない） */
export async function takeOauthState(d1: D1Database, stateHash: string, now: number) {
  return d1
    .prepare(
      `UPDATE calendar_oauth_states SET used_at = ?2
       WHERE state_hash = ?1 AND used_at IS NULL AND expires_at > ?2
       RETURNING binding_hash, user_id, provider, code_verifier`,
    )
    .bind(stateHash, now)
    .first<{ binding_hash: string; user_id: string; provider: Provider; code_verifier: string }>();
}

/** 連携を書く（連携し直しでは calendar_id を残し、埋まりの記録を消す）。同じ batch で CalendarConnected */
export async function saveConnection(
  d1: D1Database,
  row: { userId: string; provider: Provider; refreshTokenEnc: string; now: number },
  event: { id: string; payload: string },
): Promise<boolean> {
  const [saved] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO calendar_connections (user_id, provider, status, refresh_token_enc, connected_at, updated_at)
         SELECT ?1, ?2, 'active', ?3, ?4, ?4 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND withdrawn_at IS NULL)
         ON CONFLICT (user_id, provider) DO UPDATE SET status = 'active', refresh_token_enc = ?3, connected_at = ?4,
           updated_at = ?4, busy_snapshot = NULL, snapshot_from = NULL, snapshot_to = NULL, last_synced_at = NULL,
           sync_id = NULL, sync_lease_until = NULL, large_change_held = 0, dormant_since = NULL`,
      )
      .bind(row.userId, row.provider, row.refreshTokenEnc, row.now),
    d1
      // 退会した人（T-16）には連携を作り直さない。進行中の連携の callback が、抜け殻に書かないように
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT ?1, 'CalendarConnected', ?2, ?3 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?4 AND withdrawn_at IS NULL)`,
      )
      .bind(event.id, event.payload, row.now, row.userId),
  ]);
  // 書けたら true。退会した人（T-16）には書かないので false
  return saved?.meta.changes === 1;
}

// ---- 解除と失効 ----

/** 連携をやめる。やめた行の更新用トークン（なければ null）を返す。連携していなければ undefined */
export async function disconnect(d1: D1Database, userId: string, provider: Provider, now: number) {
  // RETURNING は更新後の値を返すので、更新前のトークンは同じ batch（トランザクション）の SELECT で読む
  const [before, updated] = await d1.batch([
    d1
      .prepare(
        `SELECT refresh_token_enc FROM calendar_connections
         WHERE user_id = ?1 AND provider = ?2 AND status != 'disconnected'`,
      )
      .bind(userId, provider),
    d1
      .prepare(
        `UPDATE calendar_connections
         SET status = 'disconnected', refresh_token_enc = NULL, busy_snapshot = NULL, snapshot_from = NULL,
           snapshot_to = NULL, last_synced_at = NULL, sync_id = NULL, sync_lease_until = NULL, large_change_held = 0,
           updated_at = ?3
         WHERE user_id = ?1 AND provider = ?2 AND status != 'disconnected'`,
      )
      .bind(userId, provider, now),
  ]);
  if (updated?.meta.changes !== 1) return undefined;
  const row = (before?.results[0] ?? null) as { refresh_token_enc: string | null } | null;
  return row?.refresh_token_enc ?? null;
}

/**
 * Google 側で失効していた（invalid_grant）。active のときだけ needs_reauth にし、CalendarReauthRequired を書く。
 * 退会した人（T-16）の連携は変えず、イベントも書かない（入口を止める段のあとに書かれた行は消されないため）
 */
export async function markNeedsReauth(
  d1: D1Database,
  userId: string,
  provider: Provider,
  event: { id: string; payload: string },
  now: number,
) {
  const tid = crypto.randomUUID();
  await d1.batch([
    d1
      .prepare(
        `UPDATE calendar_connections
         SET status = 'needs_reauth', refresh_token_enc = NULL, busy_snapshot = NULL, snapshot_from = NULL,
           snapshot_to = NULL, sync_lease_until = NULL, sync_id = ?4, large_change_held = 0, updated_at = ?3
         WHERE user_id = ?1 AND provider = ?2 AND status = 'active'
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)`,
      )
      .bind(userId, provider, now, tid),
    d1
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT ?1, 'CalendarReauthRequired', ?2, ?3
         WHERE EXISTS (SELECT 1 FROM calendar_connections WHERE user_id = ?4 AND provider = ?5 AND sync_id = ?6)`,
      )
      .bind(event.id, event.payload, now, userId, provider, tid),
  ]);
}

// ---- 「ここ暇」カレンダー ----

/**
 * まだなければ書く。書けたら true（同時に別の処理が書いていたら false）。退会した人（T-16）には書かない
 * （書けなければ呼び出し側が作ったカレンダーを消すので、後始末のあとに Google 側に残らない）
 */
export async function setCalendarIdIfEmpty(d1: D1Database, userId: string, provider: Provider, calendarId: string) {
  const result = await d1
    .prepare(
      `UPDATE calendar_connections SET calendar_id = ?3
       WHERE user_id = ?1 AND provider = ?2 AND calendar_id IS NULL AND status = 'active'
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)`,
    )
    .bind(userId, provider, calendarId)
    .run();
  return result.meta.changes === 1;
}

/** 使えなかったカレンダーを外す（同じ ID のときだけ） */
export async function clearCalendarId(d1: D1Database, userId: string, provider: Provider, calendarId: string) {
  await d1
    .prepare("UPDATE calendar_connections SET calendar_id = NULL WHERE user_id = ?1 AND provider = ?2 AND calendar_id = ?3")
    .bind(userId, provider, calendarId)
    .run();
}

/** 指定した人のうち、連携が active の人 */
export async function activeConnectionsOf(d1: D1Database, userIds: string[], provider: Provider) {
  if (userIds.length === 0) return [];
  const { results } = await d1
    .prepare(
      `SELECT * FROM calendar_connections
       WHERE provider = ?2 AND status = 'active' AND user_id IN (SELECT value FROM json_each(?1))
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)`,
    )
    .bind(JSON.stringify(userIds), provider)
    .all<ConnectionRow>();
  return results;
}

// ---- 定期の確認 ----

/**
 * 確認する連携。active で休眠でなく、前回の確認から minAge 以上たったものを古い順に。SQLite は昇順で NULL を先に並べるので、
 * 確認したことがない連携が先。インデックス (status, dormant_since, last_synced_at) の範囲を順に読む（T-17「データ」）
 */
export async function connectionsDueForSync(d1: D1Database, now: number, minAge: number, limit: number) {
  const { results } = await d1
    .prepare(
      `SELECT user_id, provider FROM calendar_connections
       WHERE status = 'active' AND dormant_since IS NULL
         AND (last_synced_at IS NULL OR last_synced_at <= ?1)
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)
       ORDER BY last_synced_at LIMIT ?2`,
    )
    .bind(now - minAge, limit)
    .all<{ user_id: string; provider: Provider }>();
  return results;
}

/**
 * 確認の権利を取る。取れたら、その時点の行（lease の値を含む）。休眠中は取れない（T-17「8.」）。
 * 退会した人（T-16）も取れない（退会より前に割り当てて Queue に残っていた確認で Google を呼ばない）
 */
export async function takeSyncLease(d1: D1Database, userId: string, provider: Provider, now: number, leaseMs: number) {
  return d1
    .prepare(
      `UPDATE calendar_connections SET sync_lease_until = ?3
       WHERE user_id = ?1 AND provider = ?2 AND status = 'active' AND dormant_since IS NULL
         AND (sync_lease_until IS NULL OR sync_lease_until < ?4)
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)
       RETURNING *`,
    )
    .bind(userId, provider, now + leaseMs, now)
    .first<ConnectionRow>();
}

/** 権利を戻す（失敗した確認）。権利を持っているときだけ */
export async function releaseSyncLease(d1: D1Database, userId: string, provider: Provider, lease: number) {
  await d1
    .prepare(
      `UPDATE calendar_connections SET sync_lease_until = NULL
       WHERE user_id = ?1 AND provider = ?2 AND sync_lease_until = ?3`,
    )
    .bind(userId, provider, lease)
    .run();
}

/**
 * 保留（取り消しが多すぎる1回目）：記録も last_synced_at も進めず、large_change_held = 1 にする。
 * last_synced_at を進めると「前回の確認より前に作った」の基準がずれ、予定を見たうえで作ったここ暇まで対象に入るため
 */
export async function holdLargeChange(d1: D1Database, userId: string, provider: Provider, lease: number) {
  await d1
    .prepare(
      `UPDATE calendar_connections
       SET large_change_held = 1, sync_id = ?4, sync_lease_until = NULL
       WHERE user_id = ?1 AND provider = ?2 AND status = 'active' AND dormant_since IS NULL AND sync_lease_until = ?3`,
    )
    .bind(userId, provider, lease, crypto.randomUUID())
    .run();
}

/**
 * 記録を進める文。権利を持っていて休眠でなく、退会していない（T-16。確認の途中で退会した）ときだけ書き、sync_id に
 * 新しい値を入れる。同じ batch の後続の文は syncGuard の条件（この sync_id の行がある）で書く
 */
export function advanceSnapshotStatement(
  d1: D1Database,
  row: { userId: string; provider: Provider; lease: number; syncId: string },
  snapshot: { busy: string; from: number; to: number },
  now: number,
) {
  return d1
    .prepare(
      `UPDATE calendar_connections
       SET busy_snapshot = ?4, snapshot_from = ?5, snapshot_to = ?6, last_synced_at = ?7, large_change_held = 0,
         sync_id = ?8, sync_lease_until = NULL
       WHERE user_id = ?1 AND provider = ?2 AND status = 'active' AND dormant_since IS NULL AND sync_lease_until = ?3
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)`,
    )
    .bind(row.userId, row.provider, row.lease, snapshot.busy, snapshot.from, snapshot.to, now, row.syncId);
}

/** 後続の文の条件：この確認で記録を進めたときだけ（?n 利用者、?n+1 プロバイダ、?n+2 sync_id） */
export function syncGuard(userId: string, provider: Provider, syncId: string) {
  return {
    sql: (n: number) =>
      `EXISTS (SELECT 1 FROM calendar_connections WHERE user_id = ?${n} AND provider = ?${n + 1} AND sync_id = ?${n + 2})`,
    binds: [userId, provider, syncId] as const,
  };
}

// ---- 休眠（docs/specs/T-17-retention.md「8.」） ----

/** 休眠にする・戻すとき、ログインで戻すときに書く値（埋まりの記録を消し、進行中の確認の権利と sync_id を変える） */
const DORMANCY_RESET =
  "busy_snapshot = NULL, snapshot_from = NULL, snapshot_to = NULL, last_synced_at = NULL, large_change_held = 0, sync_lease_until = NULL";

/** 使える更新用トークンがある（c は calendar_connections、?1 は今） */
const USABLE_REFRESH_TOKEN = `EXISTS (
  SELECT 1 FROM sessions s JOIN refresh_tokens rt ON rt.session_id = s.id
  WHERE s.user_id = c.user_id AND s.revoked_at IS NULL AND s.expires_at > ?1 AND rt.used_at IS NULL AND rt.expires_at > ?1
)`;
/** 最後に使ってから30日以内（c は calendar_connections、?2 は今から30日前） */
const RECENTLY_USED = "EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = c.user_id AND s.last_used_at >= ?2)";

/**
 * 使える更新用トークンがなく、最後に使ってから30日を過ぎた人の active な連携を休眠にする（上限つき）。
 * 退会した人の連携は休眠にしない（T-16 の後始末で消える）。更新用トークンと calendar_id は残す。休眠にした数
 */
export async function markDormantConnections(d1: D1Database, now: number, cutoff: number, limit: number) {
  const r = await d1
    .prepare(
      `UPDATE calendar_connections
       SET dormant_since = ?1, ${DORMANCY_RESET}, sync_id = ?3, updated_at = ?1
       WHERE rowid IN (
         SELECT c.rowid FROM calendar_connections c
         WHERE c.status = 'active' AND c.dormant_since IS NULL
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id AND u.withdrawn_at IS NULL)
           AND NOT ${USABLE_REFRESH_TOKEN}
           AND NOT ${RECENTLY_USED}
         LIMIT ?4
       )`,
    )
    .bind(now, cutoff, crypto.randomUUID(), limit)
    .run();
  return r.meta.changes;
}

/**
 * 休眠中なのに、使える更新用トークンがあり、最後に使ってから30日以内の連携を戻す（定期の確認の取りこぼし。上限つき）。
 * 片方だけ当てはまる連携は変えない。戻した数
 */
export async function wakeDormantConnections(d1: D1Database, now: number, cutoff: number, limit: number) {
  const r = await d1
    .prepare(
      `UPDATE calendar_connections
       SET dormant_since = NULL, ${DORMANCY_RESET}, sync_id = ?3, updated_at = ?1
       WHERE rowid IN (
         SELECT c.rowid FROM calendar_connections c
         WHERE c.status = 'active' AND c.dormant_since IS NOT NULL
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id AND u.withdrawn_at IS NULL)
           AND ${USABLE_REFRESH_TOKEN}
           AND ${RECENTLY_USED}
         LIMIT ?4
       )`,
    )
    .bind(now, cutoff, crypto.randomUUID(), limit)
    .run();
  return r.meta.changes;
}

/**
 * ログインでセッションを作る batch に入れる文：その利用者の休眠中の連携を戻す。セッションの行ができたときだけ書く
 * （退会した人にはセッションを作らないので、戻さない）。次の確認は「記録だけ」から始まる
 */
export function wakeConnectionsStatement(d1: D1Database, userId: string, sessionId: string, now: number) {
  return d1
    .prepare(
      `UPDATE calendar_connections
       SET dormant_since = NULL, ${DORMANCY_RESET}, sync_id = ?4, updated_at = ?3
       WHERE user_id = ?1 AND dormant_since IS NOT NULL
         AND EXISTS (SELECT 1 FROM sessions WHERE id = ?2)`,
    )
    .bind(userId, sessionId, now, crypto.randomUUID());
}

// ---- 掃除 ----

export async function deleteExpiredOauthStates(d1: D1Database, before: number) {
  await d1.prepare("DELETE FROM calendar_oauth_states WHERE created_at <= ?1").bind(before).run();
}

// ---- .ics の一時的な URL ----

/**
 * 直近 windowMs の発行が limit 本未満のときだけ入れる（1つの文なので、同時に送っても上限を超えない。T-10）。
 * 入れたら true
 */
export async function insertIcsToken(
  d1: D1Database,
  row: { tokenHash: string; userId: string; meetupId: string; expiresAt: number; now: number },
  quota: { limit: number; windowMs: number },
) {
  const result = await d1
    .prepare(
      `INSERT INTO ics_tokens (token_hash, user_id, meetup_id, expires_at, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COUNT(*) FROM ics_tokens WHERE user_id = ?2 AND created_at > ?6) < ?7
         AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND withdrawn_at IS NULL)`,
    )
    .bind(row.tokenHash, row.userId, row.meetupId, row.expiresAt, row.now, row.now - quota.windowMs, quota.limit)
    .run();
  return result.meta.changes === 1;
}

/** 直近 windowMs の発行のうち、いちばん古い時刻（上限を超えたときの Retry-After のため） */
export async function oldestRecentIcsToken(d1: D1Database, userId: string, since: number) {
  const row = await d1
    .prepare("SELECT MIN(created_at) AS t FROM ics_tokens WHERE user_id = ?1 AND created_at > ?2")
    .bind(userId, since)
    .first<{ t: number | null }>();
  return row?.t ?? null;
}

/** 期限内のトークンだけ */
export async function findIcsToken(d1: D1Database, tokenHash: string, now: number) {
  return d1
    .prepare("SELECT user_id, meetup_id FROM ics_tokens WHERE token_hash = ?1 AND expires_at > ?2")
    .bind(tokenHash, now)
    .first<{ user_id: string; meetup_id: string }>();
}

export async function deleteExpiredIcsTokens(d1: D1Database, now: number) {
  await d1.prepare("DELETE FROM ics_tokens WHERE expires_at <= ?1").bind(now).run();
}

/** 退会（T-16 入口を止める段）：本人の .ics の鍵と、連携の途中の state を消す文（連携の行は後始末の段で消す） */
export function withdrawalPurgeStatements(d1: D1Database, userId: string): D1PreparedStatement[] {
  return [
    d1.prepare("DELETE FROM ics_tokens WHERE user_id = ?").bind(userId),
    d1.prepare("DELETE FROM calendar_oauth_states WHERE user_id = ?").bind(userId),
  ];
}

/** 退会（T-16 後始末の段）：連携の行を消す */
export async function deleteConnectionsOf(d1: D1Database, userId: string) {
  await d1.prepare("DELETE FROM calendar_connections WHERE user_id = ?").bind(userId).run();
}
