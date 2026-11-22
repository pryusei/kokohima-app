// Idempotency-Key の D1 アクセス（docs/specs/T-10-idempotency-cache-ratelimit.md「振る舞い」）
// 行は必ず user_id（閲覧者）で読み書きする。書き戻しと削除は reservation_id で自分の予約に限る

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** 処理中のまま、これより古い行は引き継げる（外部の呼び出しは5秒で打ち切るため、十分に長い） */
export const IN_PROGRESS_STALE_MS = 5 * 60 * 1000;
/** 保存する本文の上限（バイト） */
export const MAX_STORED_BODY_BYTES = 64 * 1024;

export type IdempotencyRow = {
  reservation_id: string;
  request_hash: string;
  state: "in_progress" | "done";
  status: number | null;
  content_type: string | null;
  body: string | null;
  location: string | null;
  created_at: number;
  expires_at: number;
};

/** 予約する。入れたら true（同じキーの行がすでにあれば false） */
export async function reserve(
  d1: D1Database,
  row: { userId: string; key: string; reservationId: string; requestHash: string; now: number },
) {
  const result = await d1
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys (user_id, key, reservation_id, request_hash, state, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, 'in_progress', ?5, ?6 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND withdrawn_at IS NULL)`,
    )
    .bind(row.userId, row.key, row.reservationId, row.requestHash, row.now, row.now + IDEMPOTENCY_TTL_MS)
    .run();
  return result.meta.changes === 1;
}

export async function find(d1: D1Database, userId: string, key: string) {
  return d1
    .prepare(
      `SELECT reservation_id, request_hash, state, status, content_type, body, location, created_at, expires_at
       FROM idempotency_keys WHERE user_id = ?1 AND key = ?2`,
    )
    .bind(userId, key)
    .first<IdempotencyRow>();
}

/** 読んだ予約の行だけを消す（同時に来たほかのリクエストの新しい予約は消さない） */
export async function deleteReservation(d1: D1Database, userId: string, key: string, reservationId: string) {
  await d1
    .prepare("DELETE FROM idempotency_keys WHERE user_id = ?1 AND key = ?2 AND reservation_id = ?3")
    .bind(userId, key, reservationId)
    .run();
}

/** 自分の予約がまだ処理中のときだけ、応答を書いて done にする */
export async function complete(
  d1: D1Database,
  ref: { userId: string; key: string; reservationId: string },
  res: { status: number; contentType: string | null; body: string | null; location: string | null },
) {
  await d1
    .prepare(
      `UPDATE idempotency_keys SET state = 'done', status = ?4, content_type = ?5, body = ?6, location = ?7
       WHERE user_id = ?1 AND key = ?2 AND reservation_id = ?3 AND state = 'in_progress'`,
    )
    .bind(ref.userId, ref.key, ref.reservationId, res.status, res.contentType, res.body, res.location)
    .run();
}

/** 自分の予約がまだ処理中のときだけ消す（409・429・5xx・例外のあと） */
export async function release(d1: D1Database, ref: { userId: string; key: string; reservationId: string }) {
  await d1
    .prepare(
      "DELETE FROM idempotency_keys WHERE user_id = ?1 AND key = ?2 AND reservation_id = ?3 AND state = 'in_progress'",
    )
    .bind(ref.userId, ref.key, ref.reservationId)
    .run();
}

export async function deleteExpiredIdempotencyKeys(d1: D1Database, now: number) {
  await d1.prepare("DELETE FROM idempotency_keys WHERE expires_at < ?1").bind(now).run();
}

/** 退会（T-16）：本人の冪等キーの行を消す文 */
export function withdrawalPurgeIdempotencyStatements(d1: D1Database, userId: string): D1PreparedStatement[] {
  return [d1.prepare("DELETE FROM idempotency_keys WHERE user_id = ?").bind(userId)];
}
