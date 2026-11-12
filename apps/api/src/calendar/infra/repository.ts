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
};

export async function findConnection(d1: D1Database, userId: string, provider: Provider) {
  return d1
    .prepare("SELECT * FROM calendar_connections WHERE user_id = ?1 AND provider = ?2")
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
       WHERE (SELECT COUNT(*) FROM calendar_oauth_states WHERE user_id = ?3 AND created_at > ?8) < ?9`,
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
) {
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO calendar_connections (user_id, provider, status, refresh_token_enc, connected_at, updated_at)
         VALUES (?1, ?2, 'active', ?3, ?4, ?4)
         ON CONFLICT (user_id, provider) DO UPDATE SET status = 'active', refresh_token_enc = ?3, connected_at = ?4,
           updated_at = ?4, busy_snapshot = NULL, snapshot_from = NULL, snapshot_to = NULL, last_synced_at = NULL,
           sync_id = NULL, sync_lease_until = NULL, large_change_held = 0`,
      )
      .bind(row.userId, row.provider, row.refreshTokenEnc, row.now),
    d1
      .prepare("INSERT INTO outbox (id, type, payload, created_at) VALUES (?1, 'CalendarConnected', ?2, ?3)")
      .bind(event.id, event.payload, row.now),
  ]);
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

/** Google 側で失効していた（invalid_grant）。active のときだけ needs_reauth にし、CalendarReauthRequired を書く */
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
         WHERE user_id = ?1 AND provider = ?2 AND status = 'active'`,
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

/** まだなければ書く。書けたら true（同時に別の処理が書いていたら false） */
export async function setCalendarIdIfEmpty(d1: D1Database, userId: string, provider: Provider, calendarId: string) {
  const result = await d1
    .prepare(
      `UPDATE calendar_connections SET calendar_id = ?3
       WHERE user_id = ?1 AND provider = ?2 AND calendar_id IS NULL AND status = 'active'`,
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
       WHERE provider = ?2 AND status = 'active' AND user_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(userIds), provider)
    .all<ConnectionRow>();
  return results;
}

// ---- 定期の確認 ----

/** 確認する連携。active で、前回の確認から minAge 以上たったものを古い順に */
export async function connectionsDueForSync(d1: D1Database, now: number, minAge: number, limit: number) {
  const { results } = await d1
    .prepare(
      `SELECT user_id, provider FROM calendar_connections
       WHERE status = 'active' AND (last_synced_at IS NULL OR last_synced_at <= ?1)
       ORDER BY last_synced_at IS NOT NULL, last_synced_at LIMIT ?2`,
    )
    .bind(now - minAge, limit)
    .all<{ user_id: string; provider: Provider }>();
  return results;
}

/** 確認の権利を取る。取れたら、その時点の行（lease の値を含む） */
export async function takeSyncLease(d1: D1Database, userId: string, provider: Provider, now: number, leaseMs: number) {
  return d1
    .prepare(
      `UPDATE calendar_connections SET sync_lease_until = ?3
       WHERE user_id = ?1 AND provider = ?2 AND status = 'active' AND (sync_lease_until IS NULL OR sync_lease_until < ?4)
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

/** 保留（取り消しが多すぎる1回目）：記録を進めず、large_change_held = 1 にする */
export async function holdLargeChange(d1: D1Database, userId: string, provider: Provider, lease: number, now: number) {
  await d1
    .prepare(
      `UPDATE calendar_connections
       SET large_change_held = 1, last_synced_at = ?4, sync_id = ?5, sync_lease_until = NULL
       WHERE user_id = ?1 AND provider = ?2 AND status = 'active' AND sync_lease_until = ?3`,
    )
    .bind(userId, provider, lease, now, crypto.randomUUID())
    .run();
}

/**
 * 記録を進める文。権利を持っているときだけ書き、sync_id に新しい値を入れる。同じ batch の後続の文は
 * syncGuard の条件（この sync_id の行がある）で書く
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
       WHERE user_id = ?1 AND provider = ?2 AND status = 'active' AND sync_lease_until = ?3`,
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

// ---- 掃除 ----

export async function deleteExpiredOauthStates(d1: D1Database, before: number) {
  await d1.prepare("DELETE FROM calendar_oauth_states WHERE created_at <= ?1").bind(before).run();
}

// ---- .ics の一時的な URL ----

export async function insertIcsToken(
  d1: D1Database,
  row: { tokenHash: string; userId: string; meetupId: string; expiresAt: number; now: number },
) {
  await d1
    .prepare("INSERT INTO ics_tokens (token_hash, user_id, meetup_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(row.tokenHash, row.userId, row.meetupId, row.expiresAt, row.now)
    .run();
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
