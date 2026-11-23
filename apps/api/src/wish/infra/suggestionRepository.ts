import { PENDING_WINDOW_MS, type AttemptCounts } from "../domain/suggestion";

// 行きたいのAI提案の回数の記録（docs/specs/T-29-wish-suggestion.md「データ」）。入力の言葉・候補は書かない

export type Bounds = { now: number; localStart: number; utcStart: number };
export type Limits = { userDailyLimit: number; userDailyAttempts: number; globalDailyLimit: number };

/** 数える（quota と、足せなかったときの理由の読み直し）。閲覧者の行だけで数える（全体の数を除く） */
export async function countAttempts(d1: D1Database, userId: string, b: Bounds): Promise<AttemptCounts> {
  const row = await d1
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM wish_suggestion_attempts WHERE user_id = ?1 AND outcome = 'pending' AND created_at > ?2) AS in_flight,
         (SELECT COUNT(*) FROM wish_suggestion_attempts WHERE user_id = ?1 AND created_at >= ?3
            AND (outcome = 'found' OR (outcome = 'pending' AND created_at > ?2))) AS found,
         (SELECT COUNT(*) FROM wish_suggestion_attempts WHERE user_id = ?1 AND created_at >= ?3) AS attempts,
         (SELECT COUNT(*) FROM wish_suggestion_attempts WHERE created_at >= ?4) AS global`,
    )
    .bind(userId, b.now - PENDING_WINDOW_MS, b.localStart, b.utcStart)
    .first<{ in_flight: number; found: number; attempts: number; global: number }>();
  return {
    inFlight: (row?.in_flight ?? 0) > 0,
    found: row?.found ?? 0,
    attempts: row?.attempts ?? 0,
    global: row?.global ?? 0,
  };
}

/**
 * 上限を確かめながら pending の行を1つの文で足す（同時に来ても上限を超えない）。足せたら true。
 * 条件は domain の admission と同じ（終わっていない回がない・探せる回数・試せる回数・全体）。退会した人には足さない
 */
export async function insertAttempt(d1: D1Database, id: string, userId: string, b: Bounds, l: Limits): Promise<boolean> {
  const r = await d1
    .prepare(
      `INSERT INTO wish_suggestion_attempts (id, user_id, outcome, created_at)
       SELECT ?1, ?2, 'pending', ?3
       WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND withdrawn_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM wish_suggestion_attempts WHERE user_id = ?2 AND outcome = 'pending' AND created_at > ?4)
         AND (SELECT COUNT(*) FROM wish_suggestion_attempts WHERE user_id = ?2 AND created_at >= ?5
                AND (outcome = 'found' OR (outcome = 'pending' AND created_at > ?4))) < ?6
         AND (SELECT COUNT(*) FROM wish_suggestion_attempts WHERE user_id = ?2 AND created_at >= ?5) < ?7
         AND (SELECT COUNT(*) FROM wish_suggestion_attempts WHERE created_at >= ?8) < ?9`,
    )
    .bind(
      id,
      userId,
      b.now,
      b.now - PENDING_WINDOW_MS,
      b.localStart,
      l.userDailyLimit,
      l.userDailyAttempts,
      b.utcStart,
      l.globalDailyLimit,
    )
    .run();
  return r.meta.changes === 1;
}

/** 結果の種類を書く。pending からだけ進める（条件付きの更新） */
export async function finishAttempt(d1: D1Database, id: string, outcome: "found" | "empty" | "failed", now: number) {
  await d1
    .prepare("UPDATE wish_suggestion_attempts SET outcome = ?1, finished_at = ?2 WHERE id = ?3 AND outcome = 'pending'")
    .bind(outcome, now, id)
    .run();
}

/** 掃除（T-17）：createdBefore より前の行を消す（上限つき）。消した数 */
export async function deleteAttemptsBefore(d1: D1Database, createdBefore: number, limit: number) {
  const r = await d1
    .prepare(
      "DELETE FROM wish_suggestion_attempts WHERE id IN (SELECT id FROM wish_suggestion_attempts WHERE created_at < ?1 LIMIT ?2)",
    )
    .bind(createdBefore, limit)
    .run();
  return r.meta.changes;
}

/**
 * 退会（T-16）：本人とのつながりを切る文（行は消さない）。
 * 消すと、退会してログインし直すたびにサービス全体の1日の数が戻り、上限（利用料の歯止め）が効かなくなる。
 * 残るのは時刻と結果の種類だけで、行は掃除（UTC で3日より前）で消える
 */
export const withdrawalPurgeStatements = (d1: D1Database, userId: string): D1PreparedStatement[] => [
  d1.prepare("UPDATE wish_suggestion_attempts SET user_id = NULL WHERE user_id = ?1").bind(userId),
];
