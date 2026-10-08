import {
  createAvailabilityRequestSchema,
  createRecurrenceRuleRequestSchema,
  presetsSchema,
  rangeQuerySchema,
  recurrenceExceptionRequestSchema,
} from "@kokohima/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { problem } from "../http/problem";
import { validationFailed } from "../http/validation";
import { requireAuth } from "../identity/middleware";
import { decodeCursor, encodeCursor } from "../shared/cursor";
import * as av from "./application/availability";
import { DAY_MS } from "./domain/zonedTime";

// ここ暇のAPI（docs/specs/T-03-availability.md「API」）
// 「みんな」は /friend-availabilities（/friends/{friendId} とぶつからないように）

const ctx = (c: Context<AppEnv>) => ({ env: c.env, deps: c.var.deps });
const notFound = (c: Context<AppEnv>) => problem(c.get("requestId"), 404, "not_found", "Not Found");
const conflict = (c: Context<AppEnv>) => problem(c.get("requestId"), 409, "invalid_state", "Conflict");
const uuid = z.uuid();
const iso = (ms: number) => new Date(ms).toISOString();

async function json(c: Context<AppEnv>) {
  return c.req.json().catch(() => null);
}

/** from < to、最長 maxDays 日。不正なら null */
function parseRange(c: Context<AppEnv>, maxDays: number) {
  const q = rangeQuerySchema.safeParse(c.req.query());
  if (!q.success) return { error: q.error } as const;
  const from = Date.parse(q.data.from);
  const to = Date.parse(q.data.to);
  if (to - from > maxDays * DAY_MS) return { error: null } as const;
  return { from, to, cursor: q.data.cursor } as const;
}

const slotDto = (s: { startsAt: number; endsAt: number; label: string | null }) => ({
  startsAt: iso(s.startsAt),
  endsAt: iso(s.endsAt),
  label: s.label,
});

export function availabilityRoutes() {
  const app = new Hono<AppEnv>();
  app.use("/me/presets", requireAuth);
  app.use("/availabilities", requireAuth);
  app.use("/availabilities/*", requireAuth);
  app.use("/recurrence-rules", requireAuth);
  app.use("/recurrence-rules/*", requireAuth);
  app.use("/friend-availabilities", requireAuth);
  app.use("/friends/:friendId/availabilities", requireAuth);

  app.get("/me/presets", async (c) => c.json(await av.getPresets(ctx(c), c.var.viewer.userId)));

  app.put("/me/presets", async (c) => {
    const body = presetsSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const saved = await av.putPresets(ctx(c), c.var.viewer.userId, body.data);
    return saved ? c.json(saved) : validationFailed(c, null);
  });

  app.post("/availabilities", async (c) => {
    const body = createAvailabilityRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const result = await av.createAvailability(ctx(c), c.var.viewer.userId, body.data);
    if (result.kind === "invalid") return validationFailed(c, null);
    if (result.kind === "conflict") return conflict(c);
    return c.json({ ...slotDto(result.slot), source: "manual", id: result.slot.id, date: null }, 201);
  });

  app.get("/availabilities", async (c) => {
    const range = parseRange(c, 31);
    if ("error" in range) return validationFailed(c, range.error ?? null);
    const items = await av.listMine(ctx(c), c.var.viewer.userId, range.from, range.to);
    return c.json({ items: items.map((i) => ({ ...slotDto(i), source: i.source, id: i.id, date: i.date })), nextCursor: null });
  });

  app.delete("/availabilities/:id", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success || !(await av.deleteMine(ctx(c), c.var.viewer.userId, id.data))) return notFound(c);
    return c.body(null, 204);
  });

  app.post("/recurrence-rules", async (c) => {
    const body = createRecurrenceRuleRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const result = await av.createRule(ctx(c), c.var.viewer.userId, body.data);
    if (result.kind === "invalid") return validationFailed(c, null);
    if (result.kind === "conflict") return conflict(c);
    return c.json(result.rule, 201);
  });

  app.get("/recurrence-rules", async (c) =>
    c.json({ items: await av.listRules(ctx(c), c.var.viewer.userId), nextCursor: null }),
  );

  app.delete("/recurrence-rules/:id", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success || !(await av.deleteRule(ctx(c), c.var.viewer.userId, id.data))) return notFound(c);
    return c.body(null, 204);
  });

  app.post("/recurrence-rules/:id/exceptions", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = recurrenceExceptionRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const result = await av.setException(ctx(c), c.var.viewer.userId, id.data, body.data.date, true);
    if (result === "not_found") return notFound(c);
    if (result === "invalid") return validationFailed(c, null);
    return c.body(null, 204);
  });

  app.delete("/recurrence-rules/:id/exceptions/:date", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const result = await av.setException(ctx(c), c.var.viewer.userId, id.data, c.req.param("date"), false);
    return result === "not_found" ? notFound(c) : c.body(null, 204);
  });

  app.get("/friend-availabilities", async (c) => {
    const range = parseRange(c, 14);
    if ("error" in range) return validationFailed(c, range.error ?? null);
    const cursor = range.cursor === undefined ? null : decodeCursor(range.cursor);
    if (range.cursor !== undefined && !cursor) return validationFailed(c, null);
    const page = await av.friendAvailabilities(ctx(c), c.var.viewer.userId, range, cursor);
    return c.json({ items: page.items, nextCursor: page.next ? encodeCursor(page.next) : null });
  });

  app.get("/friends/:friendId/availabilities", async (c) => {
    const friendId = uuid.safeParse(c.req.param("friendId"));
    if (!friendId.success) return notFound(c);
    const range = parseRange(c, 31);
    if ("error" in range) return validationFailed(c, range.error ?? null);
    const slots = await av.visibleSlotsFor(ctx(c), c.var.viewer.userId, friendId.data, range);
    if (!slots) return notFound(c);
    return c.json({ items: slots.map(slotDto), nextCursor: null });
  });

  return app;
}
