import { MINUTE_MS } from "../domain/zonedTime";

// availability のD1アクセス（docs/specs/T-03-availability.md）
// 友達の枠は「前提」の3条件をSQLに入れて取得する。friendships は読み取りだけ（T-02の「前提」の例外）

/**
 * 閲覧者（?1）に見せてよい相手のIDの副問い合わせ。
 * 1. 閲覧者→相手 の行がある 2. 相手→閲覧者 の行がある 3. 相手が閲覧者を「見せない」にしていない
 */
const VISIBLE_OWNERS = `
  SELECT f.friend_id FROM friendships f
  WHERE f.user_id = ?1
    AND EXISTS (SELECT 1 FROM friendships r WHERE r.user_id = f.friend_id AND r.friend_id = ?1)
    AND NOT EXISTS (
      SELECT 1 FROM sharing_policies sp
      WHERE sp.owner_id = f.friend_id AND sp.target_id = ?1 AND sp.visible = 0
    )`;

export type PresetRow = {
  day_start: number;
  day_end: number;
  evening_start: number;
  evening_end: number;
  night_start: number;
  night_end: number;
};

export type ManualRow = { id: string; user_id: string; starts_at: number; ends_at: number; label: string | null };
export type RuleRow = {
  id: string;
  user_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
  label: string | null;
  timezone: string;
  created_at: number;
};

export async function getPresets(d1: D1Database, userId: string) {
  return d1.prepare("SELECT * FROM presets WHERE user_id = ?1").bind(userId).first<PresetRow>();
}

export async function putPresets(d1: D1Database, userId: string, p: PresetRow, now: number) {
  await d1
    .prepare(
      `INSERT INTO presets (user_id, day_start, day_end, evening_start, evening_end, night_start, night_end, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (user_id) DO UPDATE SET day_start = ?2, day_end = ?3, evening_start = ?4, evening_end = ?5,
         night_start = ?6, night_end = ?7, updated_at = ?8`,
    )
    .bind(userId, p.day_start, p.day_end, p.evening_start, p.evening_end, p.night_start, p.night_end, now)
    .run();
}

/**
 * 自分の手動の枠と1分以上重ならず、未来の手動の枠が limit 未満のときだけ、1つの文で追加する。追加できたら true
 */
export async function insertManualWithinLimits(
  d1: D1Database,
  row: { id: string; userId: string; startsAt: number; endsAt: number; label: string | null; now: number },
  limit: number,
) {
  const result = await d1
    .prepare(
      `INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE NOT EXISTS (
           SELECT 1 FROM availabilities
           WHERE user_id = ?2 AND MIN(ends_at, ?4) - MAX(starts_at, ?3) >= ?7
         )
         AND (SELECT COUNT(*) FROM availabilities WHERE user_id = ?2 AND ends_at > ?6) < ?8`,
    )
    .bind(row.id, row.userId, row.startsAt, row.endsAt, row.label, row.now, MINUTE_MS, limit)
    .run();
  return result.meta.changes === 1;
}

/** 自分の手動の枠のうち、[from, to) と1分以上重なり、終了が now より後のもの */
export async function listMyManual(d1: D1Database, userId: string, from: number, to: number, now: number) {
  const { results } = await d1
    .prepare(
      `SELECT * FROM availabilities
       WHERE user_id = ?1 AND MIN(ends_at, ?3) - MAX(starts_at, ?2) >= ?5 AND ends_at > ?4
       ORDER BY starts_at, id`,
    )
    .bind(userId, from, to, now, MINUTE_MS)
    .all<ManualRow>();
  return results;
}

export async function deleteMyManual(d1: D1Database, userId: string, id: string) {
  const result = await d1.prepare("DELETE FROM availabilities WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
  return result.meta.changes === 1;
}

/** 同じ曜日の自分のルールと1分以上重ならず、ルールが limit 未満のときだけ、1つの文で追加する */
export async function insertRuleWithinLimits(
  d1: D1Database,
  row: Omit<RuleRow, "user_id"> & { userId: string },
  limit: number,
) {
  const result = await d1
    .prepare(
      `INSERT INTO recurrence_rules (id, user_id, weekday, start_minute, end_minute, label, timezone, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE NOT EXISTS (
           SELECT 1 FROM recurrence_rules
           WHERE user_id = ?2 AND weekday = ?3 AND MIN(end_minute, ?5) - MAX(start_minute, ?4) >= 1
         )
         AND (SELECT COUNT(*) FROM recurrence_rules WHERE user_id = ?2) < ?9`,
    )
    .bind(row.id, row.userId, row.weekday, row.start_minute, row.end_minute, row.label, row.timezone, row.created_at, limit)
    .run();
  return result.meta.changes === 1;
}

export async function listMyRules(d1: D1Database, userId: string) {
  const { results } = await d1
    .prepare("SELECT * FROM recurrence_rules WHERE user_id = ?1 ORDER BY weekday, start_minute, id")
    .bind(userId)
    .all<RuleRow>();
  return results;
}

export async function findMyRule(d1: D1Database, userId: string, id: string) {
  return d1.prepare("SELECT * FROM recurrence_rules WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<RuleRow>();
}

export async function deleteMyRule(d1: D1Database, userId: string, id: string) {
  const result = await d1.prepare("DELETE FROM recurrence_rules WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
  return result.meta.changes === 1;
}

export async function addException(d1: D1Database, ruleId: string, date: string, now: number) {
  await d1
    .prepare("INSERT OR IGNORE INTO recurrence_exceptions (rule_id, local_date, created_at) VALUES (?1, ?2, ?3)")
    .bind(ruleId, date, now)
    .run();
}

export async function removeException(d1: D1Database, ruleId: string, date: string) {
  await d1.prepare("DELETE FROM recurrence_exceptions WHERE rule_id = ?1 AND local_date = ?2").bind(ruleId, date).run();
}

/** ルールの例外（sinceDate 以降）。ルールのIDごとに返す。D1のパラメータ数の上限（100）に収まるよう分けて1回のbatchで読む */
export async function exceptionsFor(d1: D1Database, ruleIds: string[], sinceDate: string) {
  const map = new Map<string, string[]>();
  if (ruleIds.length === 0) return map;
  const statements = chunk(ruleIds, IN_CHUNK).map((ids) =>
    d1
      .prepare(
        `SELECT rule_id, local_date FROM recurrence_exceptions
         WHERE local_date >= ?1 AND rule_id IN (${ids.map((_, i) => `?${i + 2}`).join(", ")})`,
      )
      .bind(sinceDate, ...ids),
  );
  const results = await d1.batch<{ rule_id: string; local_date: string }>(statements);
  const rows = results.flatMap((r) => r.results).sort((a, b) => a.local_date.localeCompare(b.local_date));
  for (const r of rows) map.set(r.rule_id, [...(map.get(r.rule_id) ?? []), r.local_date]);
  return map;
}

const IN_CHUNK = 90;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 閲覧者に見せてよい相手（friendId を渡すとその1人だけ）の、範囲と重なる未来の手動の枠 */
export async function visibleManual(
  d1: D1Database,
  viewerId: string,
  range: { from: number; to: number; now: number },
  friendId?: string,
) {
  const { results } = await d1
    .prepare(
      `SELECT * FROM availabilities
       WHERE user_id IN (${VISIBLE_OWNERS})
         AND (?6 IS NULL OR user_id = ?6)
         AND MIN(ends_at, ?3) - MAX(starts_at, ?2) >= ?5 AND ends_at > ?4`,
    )
    .bind(viewerId, range.from, range.to, range.now, MINUTE_MS, friendId ?? null)
    .all<ManualRow>();
  return results;
}

/** 閲覧者に見せてよい相手（friendId を渡すとその1人だけ）のくり返しのルール */
export async function visibleRules(d1: D1Database, viewerId: string, friendId?: string) {
  const { results } = await d1
    .prepare(
      `SELECT * FROM recurrence_rules
       WHERE user_id IN (${VISIBLE_OWNERS}) AND (?2 IS NULL OR user_id = ?2)`,
    )
    .bind(viewerId, friendId ?? null)
    .all<RuleRow>();
  return results;
}

/** 両方向の友達関係があるか（友達の詳細の404の判定） */
export async function isMutualFriend(d1: D1Database, viewerId: string, friendId: string) {
  const row = await d1
    .prepare(
      `SELECT 1 AS ok FROM friendships f
       WHERE f.user_id = ?1 AND f.friend_id = ?2
         AND EXISTS (SELECT 1 FROM friendships r WHERE r.user_id = ?2 AND r.friend_id = ?1)`,
    )
    .bind(viewerId, friendId)
    .first();
  return row !== null;
}
