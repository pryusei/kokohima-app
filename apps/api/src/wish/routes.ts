import { createWishRequestSchema, listQuerySchema, updateWishExclusionsRequestSchema } from "@kokohima/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { idempotent } from "../http/idempotency";
import { problem } from "../http/problem";
import { rateLimit } from "../http/rateLimit";
import { validationFailed } from "../http/validation";
import { requireActiveSessionForWrites, requireAuth } from "../identity/middleware";
import { decodeCursor, encodeCursor } from "../shared/cursor";
import * as wishes from "./application/wishes";

// 行きたいの API（docs/specs/T-22-wishlist.md「API」）
// 友達でない・見せない相手にされている・存在しない ID は、すべて同じ404にする

const ctx = (c: Context<AppEnv>) => ({ env: c.env, deps: c.var.deps });
const notFound = (c: Context<AppEnv>) => problem(c.get("requestId"), 404, "not_found", "Not Found");
const conflict = (c: Context<AppEnv>) => problem(c.get("requestId"), 409, "invalid_state", "Conflict");
const uuid = z.uuid();

async function json(c: Context<AppEnv>) {
  return c.req.json().catch(() => null);
}

export function wishRoutes() {
  const app = new Hono<AppEnv>();
  app.use("/wishes", requireAuth, requireActiveSessionForWrites);
  app.use("/wishes/*", requireAuth, requireActiveSessionForWrites);
  app.use("/friend-wishes", requireAuth, requireActiveSessionForWrites);
  app.use("/friends/:friendId/wishes", requireAuth, requireActiveSessionForWrites);

  app.post("/wishes", idempotent, async (c) => {
    const body = createWishRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const result = await wishes.createWish(ctx(c), c.var.viewer.userId, body.data);
    if (result.kind === "not_found") return notFound(c);
    if (result.kind === "too_many" || result.kind === "conflict") return conflict(c);
    if (result.kind === "rate_limited") {
      const res = problem(c.get("requestId"), 429, "rate_limited", "Too Many Requests");
      res.headers.set("Retry-After", String(result.retryAfterSeconds));
      return res;
    }
    c.header("Location", `/api/v1/wishes/${result.wish.id}`);
    return c.json(result.wish, 201);
  });

  app.get("/wishes", async (c) => c.json({ items: await wishes.listMine(ctx(c), c.var.viewer.userId), nextCursor: null }));

  app.get("/wishes/:id", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    const wish = id.success ? await wishes.getWish(ctx(c), c.var.viewer.userId, id.data) : null;
    return wish ? c.json(wish) : notFound(c);
  });

  app.put("/wishes/:id/exclusions", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = updateWishExclusionsRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const result = await wishes.updateExclusions(ctx(c), c.var.viewer.userId, id.data, body.data.userIds);
    return result.kind === "ok" ? c.json(result.wish) : notFound(c);
  });

  app.delete("/wishes/:id", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success || !(await wishes.deleteWish(ctx(c), c.var.viewer.userId, id.data))) return notFound(c);
    return c.body(null, 204);
  });

  // 友達の行の数だけ読むので、利用者 ID ごとに回数の上限をかける（決めたこと9。friend-availabilities と同じ）
  app.get("/friend-wishes", rateLimit({ group: "friend_wishes", limiter: "RL_USER", by: "user" }), async (c) => {
    const q = listQuerySchema.safeParse(c.req.query());
    if (!q.success) return validationFailed(c, q.error);
    const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor);
    if (q.data.cursor !== undefined && !cursor) return validationFailed(c, null);
    const page = await wishes.friendWishGroups(ctx(c), c.var.viewer.userId, q.data.limit, cursor);
    return c.json({ items: page.items, nextCursor: page.next ? encodeCursor(page.next) : null });
  });

  app.get("/friends/:friendId/wishes", async (c) => {
    const friendId = uuid.safeParse(c.req.param("friendId"));
    const items = friendId.success ? await wishes.friendWishes(ctx(c), c.var.viewer.userId, friendId.data) : null;
    return items ? c.json({ items, nextCursor: null }) : notFound(c);
  });

  return app;
}
