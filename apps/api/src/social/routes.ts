import {
  acceptInviteRequestSchema,
  createInviteLinkRequestSchema,
  inviteLookupRequestSchema,
  listQuerySchema,
  updateFriendRequestSchema,
} from "@kokohima/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireAuth, requireSameOrigin } from "../identity/middleware";
import { clearInviteCookie, getInviteCookie, setInviteCookie } from "../http/inviteCookie";
import { problem, problemFrom } from "../http/problem";
import { validationFailed } from "../http/validation";
import * as social from "./application/social";

// 友達と招待リンクのAPI（docs/specs/T-02-friends.md「API」）

const ctx = (c: Context<AppEnv>) => ({ env: c.env, deps: c.var.deps });
const notFound = (c: Context<AppEnv>) => problemFrom(c, 404, "not_found", "Not Found");
const uuid = z.uuid();

async function json(c: Context<AppEnv>) {
  return c.req.json().catch(() => null);
}

export function socialRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/invite-links", requireAuth, async (c) => {
    const body = createInviteLinkRequestSchema.safeParse((await json(c)) ?? {});
    if (!body.success) return validationFailed(c, body.error);
    const result = await social.createInviteLink(ctx(c), c.var.viewer.userId, body.data);
    if (result.kind === "display_name_required") {
      return problem(c.get("requestId"), 409, "invalid_state", "Display name required");
    }
    if (result.kind === "rate_limited") {
      const res = problem(c.get("requestId"), 429, "rate_limited", "Too Many Requests");
      res.headers.set("Retry-After", String(result.retryAfterSeconds));
      return res;
    }
    c.header("Cache-Control", "no-store");
    return c.json(result.link, 201);
  });

  app.get("/invite-links", requireAuth, async (c) => {
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) return validationFailed(c, query.error);
    try {
      return c.json(await social.listInviteLinks(ctx(c), c.var.viewer.userId, query.data.limit, query.data.cursor));
    } catch (err) {
      if (err instanceof social.BadCursor) return validationFailed(c, null);
      throw err;
    }
  });

  app.post("/invite-links/lookup", requireSameOrigin, async (c) => {
    const body = inviteLookupRequestSchema.safeParse((await json(c)) ?? {});
    if (!body.success) return validationFailed(c, body.error);
    // 本文のトークン（最初に開いたとき）か、招待Cookieのトークン（ログインをはさんだ後）
    const token = body.data.token ?? getInviteCookie(c);
    const found = await social.lookupInvite(ctx(c), token);
    if (!found || !token) {
      clearInviteCookie(c);
      return notFound(c);
    }
    setInviteCookie(c, token);
    c.header("Cache-Control", "no-store");
    return c.json(found);
  });

  app.post("/invite-links/accept", requireSameOrigin, requireAuth, async (c) => {
    const body = acceptInviteRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const result = await social.acceptInvite(ctx(c), c.var.viewer.userId, getInviteCookie(c), body.data.linkId);
    switch (result.kind) {
      case "own_link":
        clearInviteCookie(c);
        return problemFrom(c, 409, "invalid_state", "Own invite link");
      case "not_found":
        // 表示したリンクと違う（別のタブで上書きされた）ときは、正しいタブから続けられるよう消さない
        if (!result.keepCookie) clearInviteCookie(c);
        return notFound(c);
      default:
        clearInviteCookie(c);
        return c.json({ friend: result.friend, alreadyFriends: result.kind === "already_friends" }, result.kind === "created" ? 201 : 200);
    }
  });

  app.post("/invite-links/:id/revoke", requireAuth, async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success || !(await social.revokeInviteLink(ctx(c), c.var.viewer.userId, id.data))) return notFound(c);
    return c.body(null, 204);
  });

  app.get("/friends", requireAuth, async (c) => {
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) return validationFailed(c, query.error);
    try {
      return c.json(await social.listFriends(ctx(c), c.var.viewer.userId, query.data.limit, query.data.cursor));
    } catch (err) {
      if (err instanceof social.BadCursor) return validationFailed(c, null);
      throw err;
    }
  });

  app.get("/friends/:friendId", requireAuth, async (c) => {
    const friendId = uuid.safeParse(c.req.param("friendId"));
    if (!friendId.success) return notFound(c);
    const friend = await social.getFriend(ctx(c), c.var.viewer.userId, friendId.data);
    return friend ? c.json(friend) : notFound(c);
  });

  app.patch("/friends/:friendId", requireAuth, async (c) => {
    const friendId = uuid.safeParse(c.req.param("friendId"));
    if (!friendId.success) return notFound(c);
    const body = updateFriendRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const friend = await social.updateFriend(ctx(c), c.var.viewer.userId, friendId.data, body.data.sharesMyAvailability);
    return friend ? c.json(friend) : notFound(c);
  });

  app.delete("/friends/:friendId", requireAuth, async (c) => {
    const friendId = uuid.safeParse(c.req.param("friendId"));
    if (!friendId.success || !(await social.unfriend(ctx(c), c.var.viewer.userId, friendId.data))) return notFound(c);
    return c.body(null, 204);
  });

  return app;
}
