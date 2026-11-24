import { activeUserExistsSql } from "../../identity/application/auth";

// contact の D1 の文（docs/specs/T-24-contact.md「データ」「振る舞い 1.」「3.」）。新しい表は作らず、outbox の行だけを使う
// users は直接読まない（退会の確かめは identity の activeUserExistsSql・getContactSender）

export const CONTACT_TYPE = "ContactMessageSubmitted";
/** 通報（docs/specs/T-33-block-report.md「データ」）。問い合わせと同じく outbox の行だけを使い、同じ関数で書く・数える・消す */
export const REPORT_TYPE = "UserReported";
export type OutboxMessageType = typeof CONTACT_TYPE | typeof REPORT_TYPE;

/** outbox の行の payload（D1 の行だけに置く。Queue のメッセージには載せない） */
export type ContactPayload = { userId: string; category: string; body: string; occurredAt: string };
/** 届けたあとの payload（種類と内容を消す） */
export type RedactedContactPayload = { userId: string; occurredAt: string; delivered: true };

/**
 * 1つの文で、退会していないことと回数の上限（直近 windowMs に limit 件未満）を確かめて行を書く。書けたら true。
 * 同時に送っても上限を超えない
 */
export async function insertIfAllowed(
  d1: D1Database,
  row: { id: string; userId: string; payload: string; now: number },
  limit: { count: number; windowMs: number },
  type: OutboxMessageType = CONTACT_TYPE,
): Promise<boolean> {
  const r = await d1
    .prepare(
      `INSERT INTO outbox (id, type, payload, created_at)
       SELECT ?1, ?2, ?3, ?4
       WHERE ${activeUserExistsSql("?5")}
         AND (SELECT COUNT(*) FROM outbox
              WHERE type = ?2 AND json_extract(payload, '$.userId') = ?5 AND created_at > ?4 - ?6) < ?7`,
    )
    .bind(row.id, type, row.payload, row.now, row.userId, limit.windowMs, limit.count)
    .run();
  return r.meta.changes === 1;
}

/** 窓の中でいちばん古い受け付けの時刻（Retry-After の元）。なければ null */
export async function oldestInWindow(
  d1: D1Database,
  userId: string,
  now: number,
  windowMs: number,
  type: OutboxMessageType = CONTACT_TYPE,
): Promise<number | null> {
  const row = await d1
    .prepare(
      `SELECT MIN(created_at) AS oldest FROM outbox
       WHERE type = ?1 AND json_extract(payload, '$.userId') = ?2 AND created_at > ?3 - ?4`,
    )
    .bind(type, userId, now, windowMs)
    .first<{ oldest: number | null }>();
  return row?.oldest ?? null;
}

/** 受付番号の行の payload（文字列のまま）。なければ null */
export async function findPayload(d1: D1Database, id: string, type: OutboxMessageType = CONTACT_TYPE): Promise<string | null> {
  const row = await d1.prepare("SELECT payload FROM outbox WHERE id = ?1 AND type = ?2").bind(id, type).first<{ payload: string }>();
  return row?.payload ?? null;
}

/** 届けたら種類と内容を消す。まだ届けていない行だけ（同じ行を同時に処理しても結果は同じ） */
export async function redact(
  d1: D1Database,
  id: string,
  redacted: RedactedContactPayload,
  type: OutboxMessageType = CONTACT_TYPE,
): Promise<void> {
  await d1
    .prepare(
      `UPDATE outbox SET payload = ?3
       WHERE id = ?1 AND type = ?2 AND json_extract(payload, '$.delivered') IS NULL`,
    )
    .bind(id, type, JSON.stringify(redacted))
    .run();
}
