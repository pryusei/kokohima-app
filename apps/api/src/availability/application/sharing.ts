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

export async function setSharing(d1: D1Database, ownerId: string, targetId: string, visible: boolean, now: number) {
  await drizzle(d1)
    .insert(sharingPolicies)
    .values({ ownerId, targetId, visible, updatedAt: now })
    .onConflictDoUpdate({
      target: [sharingPolicies.ownerId, sharingPolicies.targetId],
      set: { visible, updatedAt: now },
    });
}
