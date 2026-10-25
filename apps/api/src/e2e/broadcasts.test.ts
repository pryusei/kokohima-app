import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppDeps, AppEnv } from "../env";
import { e2eExpireBroadcast } from "./broadcasts";
import app from "./entry";

// E2E用：募集の期限を過ぎた状態にする経路（docs/specs/T-05-broadcast.md 決定事項5）

const NOW = Date.parse("2026-10-10T00:00:00Z");

/** 閲覧者を差し込んだ小さなアプリで、ハンドラーだけを確かめる */
function handlerApp(viewerId: string) {
  const a = new Hono<AppEnv>();
  a.use(async (c, next) => {
    c.set("requestId", "test");
    c.set("deps", { now: () => NOW } as AppDeps);
    c.set("viewer", { userId: viewerId, sessionId: "s" });
    await next();
  });
  a.post("/b/:id", e2eExpireBroadcast);
  return a;
}

async function seed() {
  const owner = crypto.randomUUID();
  const other = crypto.randomUUID();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'a', 0, 0)").bind(owner),
    env.DB.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'b', 0, 0)").bind(other),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, owner_id, starts_at, ends_at, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    ).bind(id, owner, NOW + 3_600_000, NOW + 7_200_000, NOW + 3_600_000, NOW),
  ]);
  return { owner, other, id };
}

const expiresAt = async (id: string) =>
  (await env.DB.prepare("SELECT expires_at AS e FROM broadcasts WHERE id = ?").bind(id).first<{ e: number }>())?.e;

describe("E2E用：募集の期限を過ぎた状態にする", () => {
  it("募集者の募集だけ、期限を現在より前にする", async () => {
    const { owner, other, id } = await seed();
    expect((await handlerApp(other).request(`/b/${id}`, { method: "POST" }, env)).status).toBe(404);
    expect(await expiresAt(id)).toBe(NOW + 3_600_000);
    expect((await handlerApp(owner).request(`/b/${id}`, { method: "POST" }, env)).status).toBe(204);
    expect(await expiresAt(id)).toBe(NOW - 1);
  });

  it.each([undefined, "0", ""])("E2E_MODE=%j なら、認証より前に404", async (mode) => {
    const { id } = await seed();
    const res = await app.request(`/__e2e__/broadcasts/${id}/expire`, { method: "POST" }, { ...env, E2E_MODE: mode });
    expect(res.status).toBe(404);
    expect(await expiresAt(id)).toBe(NOW + 3_600_000);
  });
});
