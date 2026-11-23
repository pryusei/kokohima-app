import { createMiddleware } from "hono/factory";
import * as z from "zod";
import type { AppEnv } from "../env";
import { sha256 } from "../shared/crypto";
import * as store from "../shared/idempotency";
import { problem } from "./problem";
import { validationFailed } from "./validation";

// Idempotency-Key（docs/specs/T-10-idempotency-cache-ratelimit.md）。対象の経路ごとに、認証の middleware の後に付ける
// 同じキーの再送には1回目の応答を返す。キー・本文はログに出さない

const keySchema = z.uuid();

/** 2xx と、409・429 以外の 4xx を保存する */
const shouldStore = (status: number) => (status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 409 && status !== 429);

function replay(row: store.IdempotencyRow): Response {
  const headers = new Headers({ "Idempotent-Replayed": "true", "Cache-Control": "no-store" });
  if (row.content_type) headers.set("Content-Type", row.content_type);
  if (row.location) headers.set("Location", row.location);
  return new Response(row.body, { status: row.status ?? 200, headers });
}

export const idempotent = createMiddleware<AppEnv>(async (c, next) => {
  const raw = c.req.header("Idempotency-Key");
  if (raw === undefined) return next();
  // 閲覧者が決まっていなければ処理しない（認証の後に付ける。付け忘れたら fail closed）
  const viewer = c.get("viewer");
  if (!viewer) throw new Error("idempotent middleware requires an authenticated viewer");
  const parsed = keySchema.safeParse(raw);
  if (!parsed.success) return validationFailed(c, parsed.error);

  const key = parsed.data;
  const userId = viewer.userId;
  const d1 = c.env.DB;
  const body = await c.req.text();
  const requestHash = await sha256(`${c.req.method}\n${new URL(c.req.url).pathname}\n${body}`);
  const reservationId = crypto.randomUUID();

  let reserved = false;
  for (let attempt = 0; attempt < 2 && !reserved; attempt++) {
    const now = c.var.deps.now();
    reserved = await store.reserve(d1, { userId, key, reservationId, requestHash, now });
    if (reserved) break;
    const row = await store.find(d1, userId, key);
    if (!row) continue; // 読む前に消えた：もう一度予約する
    const stale = row.expires_at <= now || (row.state === "in_progress" && now - row.created_at > store.IN_PROGRESS_STALE_MS);
    if (stale) {
      await store.deleteReservation(d1, userId, key, row.reservation_id);
      continue;
    }
    if (row.request_hash !== requestHash) {
      return problem(c.get("requestId"), 422, "idempotency_key_mismatch", "Idempotency-Key reused");
    }
    if (row.state === "in_progress") {
      return problem(c.get("requestId"), 409, "request_in_progress", "Request in progress");
    }
    return replay(row);
  }
  if (!reserved) return problem(c.get("requestId"), 409, "request_in_progress", "Request in progress");

  const ref = { userId, key, reservationId };
  await next();

  const res = c.res;
  if (c.error || !shouldStore(res.status)) {
    await store.release(d1, ref);
    return;
  }
  const text = res.body ? await res.clone().text() : null;
  if (text !== null && new TextEncoder().encode(text).length > store.MAX_STORED_BODY_BYTES) {
    await store.release(d1, ref);
    return;
  }
  await store.complete(d1, ref, {
    status: res.status,
    contentType: res.headers.get("Content-Type"),
    body: text,
    location: res.headers.get("Location"),
  });
});
