// wish の表（docs/specs/T-22-wishlist.md「データ」「振る舞い」）。
// 友達かどうかは、SQL の中で friendships の両方向の行を見て決める（T-04 と同じ）。social の表は読むだけ

export type WishRow = {
  id: string;
  owner_id: string;
  message: string;
  area: string | null;
  url: string | null;
  created_at: number;
};

const COLUMNS = "w.id, w.owner_id, w.message, w.area, w.url, w.created_at";

/** a と b が両方向の友達（列や値の式を渡す） */
const mutual = (a: string, b: string) =>
  `EXISTS (SELECT 1 FROM friendships f1 WHERE f1.user_id = ${a} AND f1.friend_id = ${b})
   AND EXISTS (SELECT 1 FROM friendships f2 WHERE f2.user_id = ${b} AND f2.friend_id = ${a})`;

/** 行きたい w を閲覧者 v が見られる（「見られる条件」。置いた人本人の行きたいは含めない） */
const visibleTo = (v: string) =>
  `w.owner_id <> ${v} AND ${mutual(v, "w.owner_id")}
   AND NOT EXISTS (SELECT 1 FROM wish_exclusions e WHERE e.wish_id = w.id AND e.user_id = ${v})`;

/** ids（JSON の配列）のうち、viewer の両方向の友達の数（自分は数えない） */
export async function countMutualFriends(d1: D1Database, viewerId: string, ids: string[]) {
  if (ids.length === 0) return 0;
  const row = await d1
    .prepare(`SELECT COUNT(DISTINCT j.value) AS n FROM json_each(?2) j WHERE j.value <> ?1 AND ${mutual("?1", "j.value")}`)
    .bind(viewerId, JSON.stringify(ids))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type NewWish = {
  id: string;
  ownerId: string;
  message: string;
  area: string | null;
  url: string | null;
  excludedUserIds: string[];
  now: number;
};

/**
 * 置く：1つの batch で、件数・回数・見せない相手の条件を満たすときだけ書く（どれかを超えていたら、どの行も書かない）。
 * 書けたら true
 */
export async function insertWish(d1: D1Database, w: NewWish, limits: { maxActive: number; maxPosts: number; windowStart: number }) {
  const ex = JSON.stringify(w.excludedUserIds);
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO wishes (id, owner_id, message, area, url, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE (SELECT COUNT(*) FROM wishes WHERE owner_id = ?2) < ?7
           AND (SELECT COUNT(*) FROM wish_posts WHERE user_id = ?2 AND created_at > ?8) < ?9
           AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?2 AND withdrawn_at IS NOT NULL)
           AND (SELECT COUNT(DISTINCT j.value) FROM json_each(?10) j WHERE j.value <> ?2 AND ${mutual("?2", "j.value")})
               = json_array_length(?10)`,
      )
      .bind(w.id, w.ownerId, w.message, w.area, w.url, w.now, limits.maxActive, limits.windowStart, limits.maxPosts, ex),
    d1
      .prepare(
        `INSERT INTO wish_exclusions (wish_id, user_id, created_at)
         SELECT ?1, j.value, ?2 FROM json_each(?3) j WHERE EXISTS (SELECT 1 FROM wishes WHERE id = ?1)`,
      )
      .bind(w.id, w.now, ex),
    d1
      .prepare("INSERT INTO wish_posts (id, user_id, created_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM wishes WHERE id = ?1)")
      .bind(w.id, w.ownerId, w.now),
    // リンクの取得のきっかけ（T-08）。payload に URL は入れない
    ...(w.url !== null
      ? [
          d1
            .prepare(
              `INSERT INTO outbox (id, type, payload, created_at)
               SELECT ?1, 'LinkAttached', ?2, ?3 WHERE EXISTS (SELECT 1 FROM wishes WHERE id = ?4)`,
            )
            .bind(
              crypto.randomUUID(),
              JSON.stringify({ subjectType: "wish", subjectId: w.id, occurredAt: new Date(w.now).toISOString() }),
              w.now,
              w.id,
            ),
        ]
      : []),
  ]);
  return inserted?.meta.changes === 1;
}

/** 置けなかったときの読み直し：件数・窓の中の回数・いちばん古い記録 */
export async function postStats(d1: D1Database, ownerId: string, windowStart: number) {
  const row = await d1
    .prepare(
      `SELECT (SELECT COUNT(*) FROM wishes WHERE owner_id = ?1) AS active,
              (SELECT COUNT(*) FROM wish_posts WHERE user_id = ?1 AND created_at > ?2) AS posts,
              (SELECT MIN(created_at) FROM wish_posts WHERE user_id = ?1 AND created_at > ?2) AS oldest`,
    )
    .bind(ownerId, windowStart)
    .first<{ active: number; posts: number; oldest: number | null }>();
  return { activeCount: row?.active ?? 0, postsInWindow: row?.posts ?? 0, oldestPostAt: row?.oldest ?? null };
}

/** 自分の行きたい（新しい順） */
export async function listMine(d1: D1Database, ownerId: string) {
  const { results } = await d1
    .prepare(`SELECT ${COLUMNS} FROM wishes w WHERE w.owner_id = ?1 ORDER BY w.created_at DESC, w.id DESC`)
    .bind(ownerId)
    .all<WishRow>();
  return results;
}

/** 自分の行きたい1件。自分のものでなければ null */
export async function findMine(d1: D1Database, ownerId: string, id: string) {
  return d1.prepare(`SELECT ${COLUMNS} FROM wishes w WHERE w.id = ?1 AND w.owner_id = ?2`).bind(id, ownerId).first<WishRow>();
}

/** 1件：自分のもの、または見られる条件を満たす友達のもの。どちらでもなければ null */
export async function findForViewer(d1: D1Database, viewerId: string, id: string) {
  return d1
    .prepare(`SELECT ${COLUMNS} FROM wishes w WHERE w.id = ?1 AND (w.owner_id = ?2 OR (${visibleTo("?2")}))`)
    .bind(id, viewerId)
    .first<WishRow>();
}

/** 友達1人の、閲覧者が見られる行きたい（新しい順）。友達でなければ空 */
export async function listVisibleOf(d1: D1Database, viewerId: string, ownerId: string) {
  const { results } = await d1
    .prepare(
      `SELECT ${COLUMNS} FROM wishes w WHERE w.owner_id = ?2 AND ${visibleTo("?1")}
       ORDER BY w.created_at DESC, w.id DESC`,
    )
    .bind(viewerId, ownerId)
    .all<WishRow>();
  return results;
}

/** 両方向の友達か */
export async function isMutualFriend(d1: D1Database, viewerId: string, friendId: string) {
  if (viewerId === friendId) return false;
  const row = await d1.prepare(`SELECT 1 AS x WHERE ${mutual("?1", "?2")}`).bind(viewerId, friendId).first();
  return row !== null;
}

/**
 * 見られる行きたいが1件以上ある友達（友達の一覧と同じ順：友達になった日時の新しい順、同じなら id の降順。決めたこと12）。
 * 1ページの件数は、見られる行きたいのある友達で数える（SQL の中で絞る）。limit + 1 件を返す
 */
export async function friendsWithWishes(d1: D1Database, viewerId: string, limit: number, cursor: { k: number; id: string } | null) {
  const { results } = await d1
    .prepare(
      `SELECT f.friend_id AS friend_id, f.created_at AS created_at FROM friendships f
       WHERE f.user_id = ?1
         AND EXISTS (SELECT 1 FROM friendships r WHERE r.user_id = f.friend_id AND r.friend_id = ?1)
         AND EXISTS (
           SELECT 1 FROM wishes w WHERE w.owner_id = f.friend_id
             AND NOT EXISTS (SELECT 1 FROM wish_exclusions e WHERE e.wish_id = w.id AND e.user_id = ?1))
         AND (?2 IS NULL OR f.created_at < ?2 OR (f.created_at = ?2 AND f.friend_id < ?3))
       ORDER BY f.created_at DESC, f.friend_id DESC
       LIMIT ?4`,
    )
    .bind(viewerId, cursor?.k ?? null, cursor?.id ?? "", limit + 1)
    .all<{ friend_id: string; created_at: number }>();
  return results;
}

/** 友達たちの、閲覧者が見られる行きたい（友達ごとに新しい順） */
export async function visibleWishesOf(d1: D1Database, viewerId: string, ownerIds: string[]) {
  if (ownerIds.length === 0) return [];
  const { results } = await d1
    .prepare(
      `SELECT ${COLUMNS} FROM wishes w
       WHERE w.owner_id IN (SELECT value FROM json_each(?2)) AND ${visibleTo("?1")}
       ORDER BY w.created_at DESC, w.id DESC`,
    )
    .bind(viewerId, JSON.stringify(ownerIds))
    .all<WishRow>();
  return results;
}

/** 置いた人向け：行きたいごとの見せない相手のうち、今の友達（両方向）だけ */
export async function exclusionsOf(d1: D1Database, ownerId: string, wishIds: string[]) {
  if (wishIds.length === 0) return [];
  const { results } = await d1
    .prepare(
      `SELECT e.wish_id, e.user_id FROM wish_exclusions e
       JOIN wishes w ON w.id = e.wish_id AND w.owner_id = ?1
       WHERE e.wish_id IN (SELECT value FROM json_each(?2)) AND ${mutual("?1", "e.user_id")}
       ORDER BY e.created_at, e.user_id`,
    )
    .bind(ownerId, JSON.stringify(wishIds))
    .all<{ wish_id: string; user_id: string }>();
  return results;
}

/**
 * 見せない相手を置き換える：今の友達（両方向）の分の行だけを消して、新しい一覧を入れる。
 * 友達でなくなった人の行は残す（決めたこと10。消すと、友達に戻ったときにまた見えてしまう）。
 * 自分の行きたいでなければ何もしない
 */
export async function replaceExclusions(d1: D1Database, ownerId: string, wishId: string, userIds: string[], now: number) {
  await d1.batch([
    d1
      .prepare(
        `DELETE FROM wish_exclusions
         WHERE wish_id = ?1
           AND wish_id IN (SELECT id FROM wishes WHERE owner_id = ?2)
           AND user_id IN (
             SELECT f.friend_id FROM friendships f
             JOIN friendships r ON r.user_id = f.friend_id AND r.friend_id = f.user_id
             WHERE f.user_id = ?2)`,
      )
      .bind(wishId, ownerId),
    d1
      .prepare(
        `INSERT OR IGNORE INTO wish_exclusions (wish_id, user_id, created_at)
         SELECT ?1, j.value, ?3 FROM json_each(?4) j
         WHERE EXISTS (SELECT 1 FROM wishes WHERE id = ?1 AND owner_id = ?2)`,
      )
      .bind(wishId, ownerId, now, JSON.stringify(userIds)),
  ]);
}

/** 消す。自分のものでなければ false。見せない相手とリンクの参照は CASCADE で消える。置いた記録は残す */
export async function deleteMine(d1: D1Database, ownerId: string, id: string) {
  // CASCADE で消える行も changes に数えられるので、消した行が返ったかで判定する
  const row = await d1.prepare("DELETE FROM wishes WHERE id = ?1 AND owner_id = ?2 RETURNING id").bind(id, ownerId).first();
  return row !== null;
}

/** LinkAttached の行きたいのリンク（閲覧者のいない consumer 用。T-08）。行がない・リンクがなければ null */
export async function linkOf(d1: D1Database, id: string) {
  const row = await d1.prepare("SELECT url FROM wishes WHERE id = ?1").bind(id).first<{ url: string | null }>();
  return row?.url ?? null;
}

/** 退会（T-16）：本人の行きたい（見せない相手・参照は CASCADE）、本人が見せない相手になっている行、置いた記録を消す文 */
export function withdrawalPurgeStatements(d1: D1Database, userId: string): D1PreparedStatement[] {
  return [
    d1.prepare("DELETE FROM wishes WHERE owner_id = ?1").bind(userId),
    d1.prepare("DELETE FROM wish_exclusions WHERE user_id = ?1").bind(userId),
    d1.prepare("DELETE FROM wish_posts WHERE user_id = ?1").bind(userId),
  ];
}

/** 掃除（T-17）：createdBefore より前の置いた記録を消す（上限つき）。消した数 */
export async function deletePostsBefore(d1: D1Database, createdBefore: number, limit: number) {
  const r = await d1
    .prepare("DELETE FROM wish_posts WHERE id IN (SELECT id FROM wish_posts WHERE created_at < ?1 LIMIT ?2)")
    .bind(createdBefore, limit)
    .run();
  return r.meta.changes;
}
