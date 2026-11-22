import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sharingPolicies } from "../infra/schema";

// 公開設定（F-07）。sharing_policies に触るのはこのファイルの関数だけ（docs/specs/T-02-friends.md「前提」）
// 呼び出し側（social）が、相手が友達であることを先に確かめる

/** owner が targetIds のそれぞれに自分のここ暇を見せるか。行がなければ true（初期値「見せる」） */
export async function getSharingFor(d1: D1Database, ownerId: string, targetIds: string[]): Promise<Map<string, boolean>> {
  const result = new Map(targetIds.map((id) => [id, true]));
  if (targetIds.length === 0) return result;
  const rows = await drizzle(d1)
    .select({ targetId: sharingPolicies.targetId, visible: sharingPolicies.visible })
    .from(sharingPolicies)
    .where(and(eq(sharingPolicies.ownerId, ownerId), inArray(sharingPolicies.targetId, targetIds)));
  for (const row of rows) result.set(row.targetId, row.visible);
  return result;
}

/** どちらかが退会していたら書かない（T-16。退会と同時の要求が、消した行を作り直さないように） */
export async function setSharing(d1: D1Database, ownerId: string, targetId: string, visible: boolean, now: number) {
  await d1
    .prepare(
      `INSERT INTO sharing_policies (owner_id, target_id, visible, updated_at)
       SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id IN (?1, ?2) AND withdrawn_at IS NOT NULL)
       ON CONFLICT (owner_id, target_id) DO UPDATE SET visible = ?3, updated_at = ?4`,
    )
    .bind(ownerId, targetId, visible ? 1 : 0, now)
    .run();
}

/**
 * viewerIds のうち、owner のここ暇を since の前から今まで、ずっと見られる人（docs/specs/T-06-calendar.md 決定事項15）。
 * 見られる＝両方向の友達関係があり、owner がその人を「見せない」にしていない（T-03 の「前提」の3条件）。
 * 「ずっと」は、両方向の友達関係がどちらも since より前に作られ、公開設定の行がないか、since より前から「見せる」であること。
 * 条件はすべてこの1つの SQL に入れる（取得したあとで絞り込まない）。ID の一覧は json_each で渡す
 */
export async function viewersWhoCanSee(d1: D1Database, ownerId: string, viewerIds: string[], since: number): Promise<Set<string>> {
  if (viewerIds.length === 0) return new Set();
  const { results } = await d1
    .prepare(
      `SELECT DISTINCT v.value AS id FROM json_each(?2) v
       WHERE EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = ?1 AND f.friend_id = v.value AND f.created_at < ?3)
         AND EXISTS (SELECT 1 FROM friendships r WHERE r.user_id = v.value AND r.friend_id = ?1 AND r.created_at < ?3)
         AND NOT EXISTS (
           SELECT 1 FROM sharing_policies sp
           WHERE sp.owner_id = ?1 AND sp.target_id = v.value AND (sp.visible = 0 OR sp.updated_at >= ?3)
         )`,
    )
    .bind(ownerId, JSON.stringify(viewerIds), since)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/** 退会（T-16）：本人が片方の公開設定（両方向）を消す文。identity の退会の batch に入れる */
export function withdrawalPurgeSharingStatements(d1: D1Database, userId: string): D1PreparedStatement[] {
  return [d1.prepare("DELETE FROM sharing_policies WHERE owner_id = ?1 OR target_id = ?1").bind(userId)];
}
