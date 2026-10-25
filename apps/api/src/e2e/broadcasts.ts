import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { problem } from "../http/problem";

// E2E用：募集の期限を過ぎた状態にする（docs/specs/T-05-broadcast.md 決定事項5）。src/e2e/entry.ts からだけ読み込む
// サーバーの時計は進めない（並列で動くほかのテストの期限やアクセストークンを壊すため）。閲覧者が募集者の募集だけに効く

export async function e2eExpireBroadcast(c: Context<AppEnv>) {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success) return problem(c.get("requestId"), 404, "not_found", "Not Found");
  const now = c.var.deps.now();
  const result = await c.env.DB.prepare("UPDATE broadcasts SET expires_at = ?1 WHERE id = ?2 AND owner_id = ?3")
    .bind(now - 1, id.data, c.var.viewer.userId)
    .run();
  if (result.meta.changes !== 1) return problem(c.get("requestId"), 404, "not_found", "Not Found");
  return c.body(null, 204);
}
