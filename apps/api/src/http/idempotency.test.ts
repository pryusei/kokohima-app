import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import type { AppEnv } from "../env";
import * as store from "../shared/idempotency";
import { runScheduled } from "../worker";
import { idempotent } from "./idempotency";

// Idempotency-Key（docs/specs/T-10-idempotency-cache-ratelimit.md）。時計は 2026-10-10T00:00:00Z

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

const MIN = 60 * 1000;
const T = (s: string, day = "11") => `2026-10-${day}T${s}:00.000Z`;
const key = () => crypto.randomUUID();
const withKey = (k: string) => ({ "Idempotency-Key": k });
const rows = async (who: User) =>
  (await env.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id = ?1").bind(who.id).all<store.IdempotencyRow & { key: string }>())
    .results;
const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n;

async function pair() {
  const a = await u.user("あき");
  const b = await u.user("べに");
  await u.befriend(a, b);
  return { a, b };
}
const inviteBody = (to: User, startsAt = T("02:00"), endsAt = T("03:00")) => ({ recipientId: to.id, startsAt, endsAt });
const createInvite = (from: User, body: unknown, headers: Record<string, string> = {}) =>
  u.call("POST", "/api/v1/direct-invites", { token: from.token, body, headers });

describe("同じキーの再送", () => {
  it("1回目と同じ状態・本文・Location・Content-Type を返し、誘いと outbox の行は1つだけ", async () => {
    const { a, b } = await pair();
    const k = key();
    const first = await createInvite(a, inviteBody(b), withKey(k));
    expect(first.status).toBe(201);
    const firstBody = await first.text();
    const again = await createInvite(a, inviteBody(b), withKey(k));
    expect(again.status).toBe(201);
    expect(await again.text()).toBe(firstBody);
    expect(again.headers.get("Location")).toBe(first.headers.get("Location"));
    expect(again.headers.get("Content-Type")).toBe(first.headers.get("Content-Type"));
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(again.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM direct_invites WHERE sender_id = ?1", a.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM outbox WHERE type = 'DirectInviteSent' AND payload LIKE ?1", `%${a.id}%`)).toBe(1);
  });

  it("同じキーで本文・パスの ID が違うと422", async () => {
    const { a, b } = await pair();
    const k = key();
    expect((await createInvite(a, inviteBody(b), withKey(k))).status).toBe(201);
    const other = await createInvite(a, inviteBody(b, T("04:00"), T("05:00")), withKey(k));
    expect(other.status).toBe(422);
    expect(((await other.json()) as { code: string }).code).toBe("idempotency_key_mismatch");
    // 同じキーを別の経路に使っても422
    const id = crypto.randomUUID();
    const decide = await u.call("POST", `/api/v1/direct-invites/${id}/decide`, { token: a.token, body: { decision: "skip" }, headers: withKey(k) });
    expect(decide.status).toBe(422);
  });

  it("1回目が処理中なら409。5分を過ぎた処理中の行は引き継ぎ、遅れて終わった1回目は上書きしない", async () => {
    const { a, b } = await pair();
    const k = key();
    const body = JSON.stringify(inviteBody(b));
    const { sha256 } = await import("../shared/crypto");
    const hash = await sha256(`POST\n/api/v1/direct-invites\n${body}`);
    const old = crypto.randomUUID();
    await store.reserve(env.DB, { userId: a.id, key: k, reservationId: old, requestHash: hash, now: h.clock.now });
    const busy = await createInvite(a, inviteBody(b), withKey(k));
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { code: string }).code).toBe("request_in_progress");
    // 409 は保存しないので、処理中の行はそのまま
    expect((await rows(a))[0]).toMatchObject({ state: "in_progress", reservation_id: old });

    h.clock.now += 5 * MIN + 1;
    await u.advance(0, a, b);
    const taken = await createInvite(a, inviteBody(b), withKey(k));
    expect(taken.status).toBe(201);
    const takenBody = await taken.text();
    // 遅れて終わった1回目（古い予約）は書き戻さない
    await store.complete(env.DB, { userId: a.id, key: k, reservationId: old }, { status: 500, contentType: null, body: "old", location: null });
    await store.release(env.DB, { userId: a.id, key: k, reservationId: old });
    const replayed = await createInvite(a, inviteBody(b), withKey(k));
    expect(replayed.status).toBe(201);
    expect(await replayed.text()).toBe(takenBody);
  });

  it("4xx は保存して同じ答えを返す。409・429 は保存せず、同じキーでやり直せる", async () => {
    const { a, b } = await pair();
    const bad = key();
    const invalid = await createInvite(a, { recipientId: b.id }, withKey(bad));
    expect(invalid.status).toBe(400);
    const again = await createInvite(a, { recipientId: b.id }, withKey(bad));
    expect(again.status).toBe(400);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");

    // 同じ誘い（キーなし）がある → キーつきは409（保存しない）
    expect((await createInvite(a, inviteBody(b))).status).toBe(201);
    const k = key();
    expect((await createInvite(a, inviteBody(b), withKey(k))).status).toBe(409);
    expect((await rows(a)).some((r) => r.key === k)).toBe(false);
  });

  it("別の利用者が同じキーを送ると、別の処理として実行され、1回目の人の応答は返らない（経路ごと）", async () => {
    const { a, b } = await pair();
    const c = await u.user("ちさ");
    await u.befriend(c, b);
    const k = key();
    const fromA = await createInvite(a, inviteBody(b), withKey(k));
    const fromC = await createInvite(c, inviteBody(b), withKey(k));
    expect(fromA.status).toBe(201);
    expect(fromC.status).toBe(201);
    expect(fromC.headers.get("Idempotent-Replayed")).toBeNull();
    expect(((await fromC.json()) as { id: string }).id).not.toBe(((await fromA.json()) as { id: string }).id);

    for (const [path, body] of [
      ["/api/v1/availabilities", { date: "2026-10-12", preset: "night" }],
      ["/api/v1/recurrence-rules", { weekday: 3, preset: "evening" }],
    ] as const) {
      const k2 = key();
      const ra = await u.call("POST", path, { token: a.token, body, headers: withKey(k2) });
      const rc = await u.call("POST", path, { token: c.token, body, headers: withKey(k2) });
      expect(ra.headers.get("Idempotent-Replayed"), path).toBeNull();
      expect(rc.headers.get("Idempotent-Replayed"), path).toBeNull();
      expect(rc.status, path).toBe(ra.status);
    }
  });

  it("対象のすべての経路で受け付ける（2回目は再送）", async () => {
    const { a, b } = await pair();
    const replays = async (who: User, path: string, body: unknown) => {
      const k = key();
      const first = await u.call("POST", path, { token: who.token, body, headers: withKey(k) });
      const second = await u.call("POST", path, { token: who.token, body, headers: withKey(k) });
      expect(second.headers.get("Idempotent-Replayed"), path).toBe("true");
      expect(second.status, path).toBe(first.status);
      return first;
    };
    await replays(a, "/api/v1/availabilities", { date: "2026-10-13", preset: "night" });
    await replays(a, "/api/v1/recurrence-rules", { weekday: 5, preset: "day" });
    const invite = (await (await replays(a, "/api/v1/direct-invites", inviteBody(b))).json()) as { id: string };
    const accepted = (await (await replays(b, `/api/v1/direct-invites/${invite.id}/responses`, { response: "accept" })).json()) as { meetupId: string };
    await replays(a, `/api/v1/meetups/${accepted.meetupId}/cancel`, undefined);
    const second = (await (await createInvite(a, inviteBody(b, T("04:00"), T("05:00")))).json()) as { id: string };
    await u.call("POST", `/api/v1/direct-invites/${second.id}/responses`, { token: b.token, body: { response: "counter", startsAt: T("06:00"), endsAt: T("07:00") } });
    await replays(a, `/api/v1/direct-invites/${second.id}/decide`, { decision: "skip" });
    const c = await u.user("ちさ");
    await u.befriend(a, c);
    const broadcast = (await (
      await replays(a, "/api/v1/broadcasts", { recipientIds: [b.id, c.id], startsAt: T("08:00"), endsAt: T("09:00") })
    ).json()) as { id: string };
    await u.call("POST", `/api/v1/broadcasts/${broadcast.id}/responses`, { token: b.token });
    await replays(a, `/api/v1/broadcasts/${broadcast.id}/decide`, undefined);
  });

  it("対象外の経路ではヘッダーを無視し、招待トークンを含む応答を保存しない", async () => {
    const { a } = await pair();
    const k = key();
    const first = await u.call("POST", "/api/v1/invite-links", { token: a.token, body: {}, headers: withKey(k) });
    const second = await u.call("POST", "/api/v1/invite-links", { token: a.token, body: {}, headers: withKey(k) });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replayed")).toBeNull();
    expect(await rows(a)).toHaveLength(0);
    const all = await env.DB.prepare("SELECT body FROM idempotency_keys").all<{ body: string | null }>();
    expect(all.results.some((r) => r.body?.includes("#t="))).toBe(false);
  });

  it("ヘッダーがなければ今までどおり。UUID でなければ400", async () => {
    const { a, b } = await pair();
    expect((await createInvite(a, inviteBody(b))).status).toBe(201);
    expect(await rows(a)).toHaveLength(0);
    const bad = await createInvite(a, inviteBody(b, T("04:00"), T("05:00")), withKey("not-a-uuid"));
    expect(bad.status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM direct_invites WHERE sender_id = ?1", a.id)).toBe(1);
  });

  it("24時間を過ぎた行は使わずにもう一度実行し、Cron で消える", async () => {
    const { a, b } = await pair();
    const k = key();
    expect((await createInvite(a, inviteBody(b), withKey(k))).status).toBe(201);
    h.clock.now += 24 * 60 * MIN + 1;
    await u.advance(0, a, b);
    const again = await createInvite(a, inviteBody(b, T("02:00", "13"), T("03:00", "13")), withKey(k));
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotent-Replayed")).toBeNull();
    h.clock.now += 24 * 60 * MIN + 1;
    await runScheduled("* * * * *", h.bindings, h.deps);
    expect(await rows(a)).toHaveLength(0);
    h.jobs.length = 0;
  });
});

describe("middleware の単体", () => {
  function miniApp(handler: (c: import("hono").Context<AppEnv>) => Response | Promise<Response>, viewer = true) {
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("requestId", "test");
      c.set("deps", h.deps);
      if (viewer) c.set("viewer", { userId: userId, sessionId: "s" });
      await next();
    });
    app.post("/x", idempotent, handler);
    app.onError(() => new Response("error", { status: 500 }));
    return app;
  }
  let userId = "";
  const send = (app: Hono<AppEnv>, k: string, body = "{}") =>
    app.request("/x", { method: "POST", headers: { "Idempotency-Key": k, "Content-Type": "application/json" }, body }, env);

  beforeEach(async () => {
    userId = (await u.user("あき")).id;
  });

  it("例外・5xx のあとは行を消し、同じキーでやり直せる", async () => {
    let calls = 0;
    const app = miniApp(() => {
      calls++;
      if (calls === 1) throw new Error("boom");
      if (calls === 2) return new Response("down", { status: 503 });
      return new Response("ok", { status: 200 });
    });
    const k = key();
    expect((await send(app, k)).status).toBe(500);
    expect((await send(app, k)).status).toBe(503);
    expect((await send(app, k)).status).toBe(200);
    const replay = await send(app, k);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(calls).toBe(3);
  });

  it("64KB を超える応答は保存しない", async () => {
    let calls = 0;
    const app = miniApp(() => {
      calls++;
      return new Response("x".repeat(64 * 1024 + 1), { status: 200 });
    });
    const k = key();
    await send(app, k);
    await send(app, k);
    expect(calls).toBe(2);
  });

  it("閲覧者がいなければ処理しない（fail closed）", async () => {
    let calls = 0;
    const app = miniApp(() => {
      calls++;
      return new Response("ok");
    }, false);
    expect((await send(app, key())).status).toBe(500);
    expect(calls).toBe(0);
  });

  it("ログにキーと本文を出さない", async () => {
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const app = miniApp(() => new Response("secret-body"));
    const k = key();
    await send(app, k, '{"secret":"ひみつ"}');
    await send(app, k, '{"secret":"ひみつ"}');
    const logged = [...log.mock.calls, ...err.mock.calls].flat().join("\n");
    expect(logged).not.toContain(k);
    expect(logged).not.toMatch(/ひみつ|secret-body/);
    log.mockRestore();
    err.mockRestore();
  });
});
