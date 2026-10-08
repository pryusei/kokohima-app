import {
  createDirectInviteRequestSchema,
  decideDirectInviteRequestSchema,
  inviteBoxSchema,
  listQuerySchema,
  respondDirectInviteRequestSchema,
} from "@kokohima/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { problem } from "../http/problem";
import { validationFailed } from "../http/validation";
import { requireAuth } from "../identity/middleware";
import { decodeCursor, encodeCursor } from "../shared/cursor";
import * as invites from "./application/directInvites";
import type { TransitionError } from "./domain/directInvite";

// 個別の誘いと成立した予定のAPI（docs/specs/T-04-direct-invite.md「API」）

const ctx = (c: Context<AppEnv>) => ({ env: c.env, deps: c.var.deps });
const notFound = (c: Context<AppEnv>) => problem(c.get("requestId"), 404, "not_found", "Not Found");
const conflict = (c: Context<AppEnv>, reason: TransitionError) =>
  problem(c.get("requestId"), 409, reason, reason === "expired" ? "Expired" : "Conflict");
const uuid = z.uuid();

async function json(c: Context<AppEnv>) {
  return c.req.json().catch(() => null);
}

/** limit・cursor の検証。壊れたカーソルは400 */
function parseList(c: Context<AppEnv>) {
  const q = listQuerySchema.safeParse(c.req.query());
  if (!q.success) return { error: q.error } as const;
  const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor);
  if (q.data.cursor !== undefined && !cursor) return { error: null } as const;
  return { limit: q.data.limit, cursor, error: undefined } as const;
}

const page = <T>(result: { items: T[]; nextCursor: { k: number; id: string } | null }) => ({
  items: result.items,
  nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
});

function transition(c: Context<AppEnv>, result: invites.TransitionResult) {
  if (result.kind === "ok") return c.json(result.invite);
  if (result.kind === "not_found") return notFound(c);
  if (result.kind === "invalid") return validationFailed(c, null);
  return conflict(c, result.reason);
}

export function invitationRoutes() {
  const app = new Hono<AppEnv>();
  app.use("/direct-invites", requireAuth);
  app.use("/direct-invites/*", requireAuth);
  app.use("/meetups", requireAuth);
  app.use("/meetups/*", requireAuth);

  app.post("/direct-invites", async (c) => {
    const body = createDirectInviteRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const result = await invites.sendInvite(ctx(c), c.var.viewer.userId, body.data);
    if (result.kind === "invalid") return validationFailed(c, null);
    if (result.kind === "not_found") return notFound(c);
    if (result.kind === "duplicate") return conflict(c, "invalid_state");
    if (result.kind === "rate_limited") {
      const res = problem(c.get("requestId"), 429, "rate_limited", "Too Many Requests");
      res.headers.set("Retry-After", String(result.retryAfterSeconds));
      return res;
    }
    c.header("Location", `/api/v1/direct-invites/${result.invite.id}`);
    return c.json(result.invite, 201);
  });

  app.get("/direct-invites", async (c) => {
    const box = inviteBoxSchema.safeParse(c.req.query("box"));
    if (!box.success) return validationFailed(c, box.error);
    const list = parseList(c);
    if (list.error !== undefined) return validationFailed(c, list.error);
    return c.json(page(await invites.listInvites(ctx(c), c.var.viewer.userId, box.data, list.limit, list.cursor)));
  });

  app.get("/direct-invites/:id", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const invite = await invites.getInvite(ctx(c), c.var.viewer.userId, id.data);
    return invite ? c.json(invite) : notFound(c);
  });

  app.post("/direct-invites/:id/responses", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = respondDirectInviteRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    return transition(c, await invites.respond(ctx(c), c.var.viewer.userId, id.data, body.data));
  });

  app.post("/direct-invites/:id/decide", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = decideDirectInviteRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    return transition(c, await invites.decide(ctx(c), c.var.viewer.userId, id.data, body.data.decision));
  });

  app.get("/meetups", async (c) => {
    const list = parseList(c);
    if (list.error !== undefined) return validationFailed(c, list.error);
    return c.json(page(await invites.listMeetups(ctx(c), c.var.viewer.userId, list.limit, list.cursor)));
  });

  app.get("/meetups/:id", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const meetup = await invites.getMeetup(ctx(c), c.var.viewer.userId, id.data);
    return meetup ? c.json(meetup) : notFound(c);
  });

  app.post("/meetups/:id/cancel", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const result = await invites.cancelMeetup(ctx(c), c.var.viewer.userId, id.data);
    if (result.kind === "ok") return c.json(result.meetup);
    if (result.kind === "not_found") return notFound(c);
    return conflict(c, result.reason);
  });

  return app;
}
