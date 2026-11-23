import { env } from "cloudflare:workers";
import { broadcastSchema, directInviteSchema, friendPageSchema, friendSchema, inviteLookupResponseSchema, meetupSchema, meResponseSchema } from "@kokohima/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, ORIGIN } from "../../test/identity-harness";
import { GPS_MARKER, includesText, jpeg } from "../../test/jpeg";
import { makeUsers, type User } from "../../test/users";
import { cleanupExpired } from "../jobs/dispatch";
import { AVATAR_GRACE_MS } from "./application/avatar";

// アイコンの画像（docs/specs/T-27-avatar-upload.md「テスト計画」）

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

const HOUR_MS = 60 * 60 * 1000;

function put(who: User | null, body: Uint8Array | string, opts: { type?: string; origin?: string | null; length?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": opts.type ?? "image/jpeg" };
  if (who) headers.Authorization = `Bearer ${who.token}`;
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  if (opts.length) headers["Content-Length"] = opts.length;
  return h.request("/api/v1/me/avatar", { method: "PUT", headers, body });
}

async function upload(who: User, body = jpeg()) {
  const res = await put(who, body);
  expect(res.status).toBe(200);
  const me = meResponseSchema.parse(await res.json());
  expect(me.avatarUrl).not.toBeNull();
  return me.avatarUrl!;
}

const idOf = (url: string) => new URL(url, ORIGIN).pathname.split("/").pop()!;
const fetchImage = (url: string) => h.request(url, { method: "GET" });
const me = async (who: User) => meResponseSchema.parse(await (await u.call("GET", "/api/v1/me", { token: who.token })).json());
const friendOf = async (viewer: User, id: string) => friendSchema.parse(await (await u.call("GET", `/api/v1/friends/${id}`, { token: viewer.token })).json());
const friends = async (viewer: User) => friendPageSchema.parse(await (await u.call("GET", "/api/v1/friends", { token: viewer.token })).json()).items;
const avatarIdInDb = async (userId: string) =>
  (await env.DB.prepare("SELECT avatar_id FROM users WHERE id = ?").bind(userId).first<{ avatar_id: string | null }>())?.avatar_id ?? null;

/** 渡した ID のうち、台帳に残っているもの（ほかのテストの行は見ない） */
const ledger = async (ids: string[]) =>
  (await env.DB.prepare("SELECT id FROM avatar_images WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ids)).all<{ id: string }>()).results
    .map((r) => r.id)
    .sort();

async function expectSameNotFound(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.text()).toBe("");
}

describe("PUT /me/avatar", () => {
  it("置くと自分の avatarUrl が入り、R2 には除去したあとのバイトが置かれ、台帳に行がある", async () => {
    const a = await u.user("あき");
    const url = await upload(a, jpeg({ exif: true, comment: "c" }));
    expect(url).toMatch(/^\/api\/v1\/avatars\/[0-9a-f-]{36}\?e=\d+&s=[\w-]+$/);
    const id = idOf(url);
    expect(await avatarIdInDb(a.id)).toBe(id);
    const stored = await env.AVATARS.get(`avatars/v1/${id}`);
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(includesText(bytes, GPS_MARKER)).toBe(false);
    expect(bytes).toEqual(jpeg());
    expect(stored!.httpMetadata?.contentType).toBe("image/jpeg");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM avatar_images WHERE id = ?").bind(id).first<{ n: number }>()).toEqual({ n: 1 });
    expect((await me(a)).avatarUrl).toBe(url);
  });

  it("image/jpeg 以外・壊れた画像・256 以外の縦横は400で、各 code を返す", async () => {
    const a = await u.user();
    const codeOf = async (res: Response) => {
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; errors: { code: string }[] };
      expect(body.code).toBe("validation_failed");
      return body.errors[0]?.code;
    };
    expect(await codeOf(await put(a, jpeg(), { type: "image/png" }))).toBe("unsupported_type");
    expect(await codeOf(await put(a, "<svg/>", { type: "image/svg+xml" }))).toBe("unsupported_type");
    expect(await codeOf(await put(a, new TextEncoder().encode("<svg/>")))).toBe("invalid_image");
    expect(await codeOf(await put(a, jpeg({ width: 512, height: 512 })))).toBe("invalid_size");
    expect(await avatarIdInDb(a.id)).toBeNull();
  });

  it("200KiB を超える本文は、Content-Length があってもなくても400 too_large", async () => {
    const a = await u.user();
    const big = jpeg({ scanBytes: 200 * 1024 });
    const codeOf = async (res: Response) => {
      expect(res.status).toBe(400);
      return ((await res.json()) as { errors: { code: string }[] }).errors[0]?.code;
    };
    expect(await codeOf(await put(a, big, { length: String(big.length) }))).toBe("too_large");
    // Content-Length のない本文（読みながら数える）
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const res = await h.request("/api/v1/me/avatar", {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.token}`, Origin: ORIGIN, "Content-Type": "image/jpeg" },
      body: stream,
      // @ts-expect-error Workers の Request は duplex を受け付ける
      duplex: "half",
    });
    expect(await codeOf(res)).toBe("too_large");
    // ちょうど上限は通る
    const limit = 200 * 1024;
    const base = jpeg();
    const exact = jpeg({ scanBytes: limit - base.length });
    expect(exact.length).toBe(limit);
    expect((await put(a, exact)).status).toBe(200);
  });

  it("未ログインは401、Origin が違えば拒否", async () => {
    const a = await u.user();
    expect((await put(null, jpeg())).status).toBe(401);
    expect((await put(a, jpeg(), { origin: "https://evil.test" })).status).not.toBe(200);
    expect(await avatarIdInDb(a.id)).toBeNull();
  });

  it("回数の上限（avatar_upload）を超えると429", async () => {
    const a = await u.user();
    h.limiter.allow = () => false;
    const res = await put(a, jpeg());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(h.limiter.calls.at(-1)).toEqual({ limiter: "RL_USER", key: `avatar_upload:${a.id}` });
    expect(await avatarIdInDb(a.id)).toBeNull();
  });

  it("他人の行は変わらない（本文・経路に利用者 ID を取らない）", async () => {
    const a = await u.user();
    const b = await u.user();
    await upload(a);
    expect(await avatarIdInDb(b.id)).toBeNull();
    await u.call("DELETE", "/api/v1/me/avatar", { token: b.token });
    expect(await avatarIdInDb(a.id)).not.toBeNull();
  });
});

describe("DELETE /me/avatar", () => {
  it("204 で avatar_id が NULL。もともとなくても204", async () => {
    const a = await u.user();
    await upload(a);
    expect((await u.call("DELETE", "/api/v1/me/avatar", { token: a.token })).status).toBe(204);
    expect(await avatarIdInDb(a.id)).toBeNull();
    expect((await me(a)).avatarUrl).toBeNull();
    expect((await u.call("DELETE", "/api/v1/me/avatar", { token: a.token })).status).toBe(204);
    expect((await u.call("DELETE", "/api/v1/me/avatar", {})).status).toBe(401);
  });
});

describe("公開プロフィールの avatarUrl（見える範囲）", () => {
  it("友達には入り、友達でない人には画像があっても null", async () => {
    const a = await u.user("あき");
    const b = await u.user("びー");
    const c = await u.user("しー");
    await u.befriend(a, b);
    await upload(a);
    // 友達の一覧・詳細
    expect((await friends(b)).find((f) => f.id === a.id)?.avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    expect((await friendOf(b, a.id)).avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    // 友達でない c からは見えない（404 は今のとおり）
    expect((await u.call("GET", `/api/v1/friends/${a.id}`, { token: c.token })).status).toBe(404);
  });

  it("友達を解除した相手の履歴（誘い）では null。画像がない人と同じ形", async () => {
    const a = await u.user("あき");
    const b = await u.user("びー");
    await u.befriend(a, b);
    await upload(a);
    const sent = await u.call("POST", "/api/v1/direct-invites", {
      token: a.token,
      body: { recipientId: b.id, startsAt: "2026-10-10T11:00:00.000Z", endsAt: "2026-10-10T13:00:00.000Z" },
    });
    expect(sent.status).toBe(201);
    const invite = directInviteSchema.parse(await sent.json());
    const seen = async () =>
      directInviteSchema.parse(await (await u.call("GET", `/api/v1/direct-invites/${invite.id}`, { token: b.token })).json());
    expect((await seen()).counterpart.avatarUrl).not.toBeNull();
    expect((await u.call("DELETE", `/api/v1/friends/${a.id}`, { token: b.token })).status).toBe(204);
    const after = await seen();
    expect(after.counterpart).toEqual({ id: a.id, displayName: "あき", avatarUrl: null, withdrawn: false });
  });

  it("募集で成立した予定の参加者どうしで、友達でない相手（知らない人）には画像があっても null。友達には入る", async () => {
    const owner = await u.user("おーなー");
    const a = await u.user("あき");
    const c = await u.user("しー");
    await u.befriend(owner, a);
    await u.befriend(owner, c);
    await upload(a);
    await upload(c);
    const created = await u.call("POST", "/api/v1/broadcasts", {
      token: owner.token,
      body: { recipientIds: [a.id, c.id], startsAt: "2026-10-10T11:00:00.000Z", endsAt: "2026-10-10T13:00:00.000Z" },
    });
    expect(created.status).toBe(201);
    const bc = broadcastSchema.parse(await created.json());
    for (const who of [a, c]) expect((await u.call("POST", `/api/v1/broadcasts/${bc.id}/responses`, { token: who.token })).status).toBeLessThan(300);
    const decided = broadcastSchema.parse(await (await u.call("POST", `/api/v1/broadcasts/${bc.id}/decide`, { token: owner.token })).json());
    const meetupOf = async (who: User) =>
      meetupSchema.parse(await (await u.call("GET", `/api/v1/meetups/${decided.meetupId}`, { token: who.token })).json());
    // a と c は友達でない：おたがいの表示名は見えるが、アイコンは画像がない人と同じ形
    expect((await meetupOf(c)).participants.find((p) => p.id === a.id)).toEqual({ id: a.id, displayName: "あき", avatarUrl: null, withdrawn: false });
    expect((await meetupOf(a)).participants.find((p) => p.id === c.id)).toEqual({ id: c.id, displayName: "しー", avatarUrl: null, withdrawn: false });
    // 募集した人は2人の友達なので入る
    const seenByOwner = (await meetupOf(owner)).participants;
    expect(seenByOwner.find((p) => p.id === a.id)?.avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    expect(seenByOwner.find((p) => p.id === c.id)?.avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
  });

  it("PATCH /me の応答にも自分の avatarUrl が入る", async () => {
    const a = await u.user();
    const url = await upload(a);
    const res = await u.call("PATCH", "/api/v1/me", { token: a.token, body: { displayName: "かわった" } });
    expect(meResponseSchema.parse(await res.json()).avatarUrl).toBe(url);
  });

  it("招待リンクを開いた人には、友達でなくても発行者のアイコンが入る", async () => {
    const a = await u.user("あき");
    await upload(a);
    const link = (await (await u.call("POST", "/api/v1/invite-links", { token: a.token, body: {} })).json()) as { url: string };
    const token = decodeURIComponent(link.url.split("#t=")[1] ?? "");
    const res = await u.call("POST", "/api/v1/invite-links/lookup", { body: { token } });
    expect(res.status).toBe(200);
    const body = inviteLookupResponseSchema.parse(await res.json());
    expect(body.inviter.avatarUrl).toMatch(/^\/api\/v1\/avatars\//);
    expect((await fetchImage(body.inviter.avatarUrl!)).status).toBe(200);
  });

  it("退会した人は null", async () => {
    const a = await u.user("あき");
    const b = await u.user("びー");
    await u.befriend(a, b);
    await upload(a);
    await env.DB.prepare("UPDATE users SET withdrawn_at = ?2 WHERE id = ?1").bind(a.id, h.clock.now).run();
    expect((await friends(b)).find((f) => f.id === a.id)?.avatarUrl ?? null).toBeNull();
  });
});

describe("GET /avatars/{avatarId}", () => {
  it("正しい URL は画像とヘッダー一式", async () => {
    const a = await u.user();
    const url = await upload(a);
    const res = await fetchImage(url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(jpeg());
    expect(Object.fromEntries(["Content-Type", "X-Content-Type-Options", "Content-Security-Policy", "Cache-Control", "Cross-Origin-Resource-Policy", "Content-Disposition", "Referrer-Policy"].map((k) => [k, res.headers.get(k)]))).toEqual({
      "Content-Type": "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=3600",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": "inline",
      "Referrer-Policy": "no-referrer",
    });
  });

  it("署名違い・別の ID への付け替え・期限切れ・遠すぎる期限・壊れた ID は、どれも同じ404", async () => {
    const a = await u.user();
    const b = await u.user();
    const urlA = new URL(await upload(a), ORIGIN);
    const urlB = new URL(await upload(b), ORIGIN);
    const e = urlA.searchParams.get("e")!;
    const s = urlA.searchParams.get("s")!;
    const variants = [
      `${urlA.pathname}?e=${e}&s=${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`,
      `${urlB.pathname}?e=${e}&s=${s}`,
      `${urlA.pathname}?e=${Number(e) + 3600}&s=${s}`,
      `${urlA.pathname}?e=${e}`,
      `${urlA.pathname}?s=${s}`,
      `${urlA.pathname}?e=abc&s=${s}`,
      `/api/v1/avatars/not-a-uuid?e=${e}&s=${s}`,
    ];
    for (const v of variants) await expectSameNotFound(await fetchImage(v));
    // 期限を過ぎると404
    h.clock.now += 2 * HOUR_MS + 1000;
    await expectSameNotFound(await fetchImage(urlA.pathname + urlA.search));
  });

  it("署名が違うときは D1・R2 を読まない", async () => {
    const a = await u.user();
    const url = new URL(await upload(a), ORIGIN);
    const r2 = vi.spyOn(env.AVATARS, "get");
    const prepare = vi.spyOn(env.DB, "prepare");
    await expectSameNotFound(await fetchImage(`${url.pathname}?e=${url.searchParams.get("e")}&s=AAAAAAAAAAAAAAAAAAAAAA`));
    expect(r2).not.toHaveBeenCalled();
    expect(prepare.mock.calls.some(([sql]) => /avatar/.test(sql))).toBe(false);
    r2.mockRestore();
    prepare.mockRestore();
  });

  it("変えたあとの古い URL・外したあと・退会のあとは404", async () => {
    const a = await u.user();
    const first = await upload(a);
    const second = await upload(a);
    expect(idOf(first)).not.toBe(idOf(second));
    await expectSameNotFound(await fetchImage(first));
    expect((await fetchImage(second)).status).toBe(200);
    await u.call("DELETE", "/api/v1/me/avatar", { token: a.token });
    await expectSameNotFound(await fetchImage(second));
    const third = await upload(a);
    await env.DB.prepare("UPDATE users SET withdrawn_at = ?2 WHERE id = ?1").bind(a.id, h.clock.now).run();
    await expectSameNotFound(await fetchImage(third));
  });

  it("同じ1時間の中では同じ URL", async () => {
    const a = await u.user();
    const url = await upload(a);
    h.clock.now += 60 * 1000;
    expect((await me(a)).avatarUrl).toBe(url);
  });
});

describe("ログ", () => {
  it("置く・検証の失敗・配信・404 のログに、avatarId・署名・画像の中身が出ない", async () => {
    const a = await u.user();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const url = new URL(await upload(a, jpeg({ exif: true })), ORIGIN);
    await put(a, jpeg({ width: 1 }));
    await put(a, new TextEncoder().encode("<svg/>"));
    await fetchImage(url.pathname + url.search);
    await fetchImage(`${url.pathname}?e=${url.searchParams.get("e")}&s=AAAAAAAAAAAAAAAAAAAAAA`);
    const all = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((args) => args.map(String).join(" ")).join("\n");
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    expect(all).not.toContain(idOf(url.pathname));
    expect(all).not.toContain(url.searchParams.get("s")!);
    expect(all).not.toContain(GPS_MARKER);
    expect(all).not.toContain("JFIF");
  });
});

describe("マイグレーション", () => {
  it("users に avatar_id があり avatar_url が残らず、台帳 avatar_images とインデックスがある", async () => {
    const columns = (await env.DB.prepare("SELECT name FROM pragma_table_info('users')").all<{ name: string }>()).results.map((r) => r.name);
    expect(columns).toContain("avatar_id");
    expect(columns).not.toContain("avatar_url");
    const ledger = (await env.DB.prepare("SELECT name FROM pragma_table_info('avatar_images')").all<{ name: string }>()).results.map((r) => r.name);
    expect(ledger).toEqual(["id", "created_at"]);
    const indexes = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('users_avatar_id', 'avatar_images_created')").all<{ name: string }>()).results.map((r) => r.name).sort();
    expect(indexes).toEqual(["avatar_images_created", "users_avatar_id"]);
  });
});

describe("掃除", () => {
  it("1時間を過ぎて参照されない画像は R2 と台帳から消え、参照されている画像・1時間以内の画像は残る", async () => {
    const a = await u.user();
    const old = idOf(await upload(a));
    const current = idOf(await upload(a));
    h.clock.now += AVATAR_GRACE_MS + 1000;
    // 掃除の直前に外して置き直した、1時間以内の画像
    const fresh = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO avatar_images (id, created_at) VALUES (?1, ?2)").bind(fresh, h.clock.now).run();
    await env.AVATARS.put(`avatars/v1/${fresh}`, jpeg());
    await cleanupExpired(h.ctx);
    expect(await env.AVATARS.get(`avatars/v1/${old}`)).toBeNull();
    expect(await env.AVATARS.get(`avatars/v1/${current}`)).not.toBeNull();
    expect(await env.AVATARS.get(`avatars/v1/${fresh}`)).not.toBeNull();
    expect(await ledger([old, current, fresh])).toEqual([current, fresh].sort());
  });

  it("外した・退会したあとに消える。R2 の削除に失敗したら台帳の行を残す", async () => {
    const a = await u.user();
    const b = await u.user();
    const ia = idOf(await upload(a));
    const ib = idOf(await upload(b));
    await u.call("DELETE", "/api/v1/me/avatar", { token: a.token });
    await env.DB.prepare("UPDATE users SET withdrawn_at = ?2, avatar_id = NULL WHERE id = ?1").bind(b.id, h.clock.now).run();
    h.clock.now += AVATAR_GRACE_MS + 1000;
    const failing = { ...h.ctx, env: { ...h.bindings, AVATARS: { delete: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket } };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await cleanupExpired(failing);
    expect(log.mock.calls.map(([m]) => String(m)).some((m) => m.includes("avatar_cleanup_failed"))).toBe(true);
    // ログに画像の ID は出ない
    expect(log.mock.calls.map(([m]) => String(m)).some((m) => m.includes(ia) || m.includes(ib))).toBe(false);
    log.mockRestore();
    expect(await ledger([ia, ib])).toEqual([ia, ib].sort());
    await cleanupExpired(h.ctx);
    expect(await env.AVATARS.get(`avatars/v1/${ia}`)).toBeNull();
    expect(await env.AVATARS.get(`avatars/v1/${ib}`)).toBeNull();
    expect(await ledger([ia, ib])).toEqual([]);
  });
});
