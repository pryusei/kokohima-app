import { env } from "cloudflare:workers";
import { meResponseSchema, problemSchema } from "@kokohima/shared";
import { exportSPKI, generateKeyPair, importSPKI, jwtVerify, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  completeCodeFrom,
  cookieHeader,
  cookieValue,
  createHarness,
  ORIGIN,
} from "../../test/identity-harness";

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

const uniq = () => `sub-${crypto.randomUUID()}`;

async function me(accessToken: string, extra: RequestInit = {}) {
  return h.request("/api/v1/me", { ...extra, headers: { Authorization: `Bearer ${accessToken}`, ...extra.headers } });
}

async function dbAll<T>(query: string, ...params: unknown[]) {
  return (await env.DB.prepare(query).bind(...params).all<T>()).results;
}

describe("ログインの開始", () => {
  it("Google：state・nonce・PKCE（S256）つきで認可画面へ送り、結びつけCookie（Lax）を設定する", async () => {
    const s = await h.start("google", "/friends");
    expect(s.res.status).toBe(302);
    expect(s.location.origin + s.location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(s.location.searchParams.get("scope")).toBe("openid email");
    expect(s.location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s.location.searchParams.get("code_challenge")).toBeTruthy();
    expect(s.location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/v1/auth/google/callback`);
    expect(s.state).toHaveLength(43);
    expect(s.nonce).toHaveLength(43);
    const cookie = cookieHeader(s.res, "__Host-kh_oauth") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
  });

  it("Apple：form_post で、結びつけCookieは SameSite=None。PKCEは送らない", async () => {
    const s = await h.start("apple");
    expect(s.location.searchParams.get("response_mode")).toBe("form_post");
    expect(s.location.searchParams.get("scope")).toBe("email");
    expect(s.location.searchParams.get("code_challenge")).toBeNull();
    expect(cookieHeader(s.res, "__Host-kh_oauth")).toMatch(/SameSite=None/);
  });

  it("state は生の値をD1に保存しない", async () => {
    const s = await h.start("google");
    const rows = await dbAll<{ state_hash: string }>("SELECT state_hash FROM oauth_transactions");
    expect(rows.some((r) => r.state_hash === s.state)).toBe(false);
  });
});

describe("ログイン（Google）", () => {
  it("初回はユーザーと対応づけを作り、2回目は同じユーザーになる", async () => {
    const sub = uniq();
    const first = await h.login("google", sub, { email: "a@example.com", email_verified: true });
    const second = await h.login("google", sub);
    const a = meResponseSchema.parse(await (await me(first.accessToken)).json());
    const b = meResponseSchema.parse(await (await me(second.accessToken)).json());
    expect(a.id).toBe(b.id);
    expect(a.displayName).toBeNull();
    const identities = await dbAll("SELECT * FROM user_identities WHERE subject = ?", sub);
    expect(identities).toHaveLength(1);
    const users = await dbAll<{ email: string }>("SELECT email FROM users WHERE id = ?", a.id);
    expect(users[0]?.email).toBe("a@example.com");
  });

  it("確認されていないメールアドレスは保存しない", async () => {
    const r = await h.login("google", uniq(), { email: "b@example.com", email_verified: false });
    const { id } = meResponseSchema.parse(await (await me(r.accessToken)).json());
    const users = await dbAll<{ email: string | null }>("SELECT email FROM users WHERE id = ?", id);
    expect(users[0]?.email).toBeNull();
  });

  it("トークンエンドポイントに code_verifier とクライアントシークレットを送る", async () => {
    await h.login("google", uniq());
    const req = h.tokenRequests.at(-1);
    expect(req?.body.get("code_verifier")).toBeTruthy();
    expect(req?.body.get("client_secret")).toBe("google-client-secret");
    expect(req?.body.get("redirect_uri")).toBe(`${ORIGIN}/api/v1/auth/google/callback`);
  });

  it("returnTo を引き継ぎ、危険な値は / に置き換える", async () => {
    expect((await h.login("google", uniq(), {}, "/invite/abc")).returnTo).toBe("/invite/abc");
    expect((await h.login("google", uniq(), {}, "//evil.example")).returnTo).toBe("/");
    expect((await h.login("google", uniq(), {}, "/\t/evil.example")).returnTo).toBe("/");
    expect((await h.login("google", uniq(), {}, "/api/v1/auth/google/start")).returnTo).toBe("/");
  });

  it("更新用トークンのCookieは __Host-、HttpOnly、Secure、SameSite=Strict、Path=/", async () => {
    const r = await h.login("google", uniq());
    const cookie = cookieHeader(r.response, "__Host-kh_rt") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it("D1に更新用トークンの生の値を保存しない", async () => {
    const r = await h.login("google", uniq());
    const rows = await dbAll<{ token_hash: string }>("SELECT token_hash FROM refresh_tokens");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.token_hash === r.refreshToken)).toBe(false);
  });

  it("SessionStarted を outbox に書き、メールアドレスやトークン、User-Agentの全文を含めない", async () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
    const s = await h.start("google");
    h.respondWithIdToken((p) =>
      h.signIdToken(p, { sub: uniq(), nonce: s.nonce, email: "c@example.com", email_verified: true }),
    );
    const code = completeCodeFrom(await h.callback("google", { code: "x", state: s.state }, s.binding)) ?? "";
    const res = await h.request("/api/v1/auth/complete", {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: `__Host-kh_oauth=${s.binding}`, "User-Agent": ua },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const rows = await dbAll<{ type: string; payload: string }>(
      "SELECT type, payload FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT 1",
    );
    expect(rows[0]?.type).toBe("SessionStarted");
    const payload = JSON.parse(rows[0]?.payload ?? "{}");
    expect(Object.keys(payload).sort()).toEqual(["deviceSummary", "occurredAt", "provider", "sessionId", "userId"]);
    expect(payload.deviceSummary).toBe("Safari / macOS");
    expect(rows[0]?.payload).not.toContain("c@example.com");
    expect(rows[0]?.payload).not.toContain("Mozilla");
    expect(rows[0]?.payload).not.toContain(cookieValue(res, "__Host-kh_rt"));
  });
});

describe("ログイン（Apple）", () => {
  it("初回はユーザーを作り、2回目は同じユーザーになる。文字列の \"true\" も確認済みとして扱う", async () => {
    const sub = uniq();
    const first = await h.login("apple", sub, { email: "x@privaterelay.appleid.com", email_verified: "true" });
    const second = await h.login("apple", sub);
    const a = meResponseSchema.parse(await (await me(first.accessToken)).json());
    const b = meResponseSchema.parse(await (await me(second.accessToken)).json());
    expect(a.id).toBe(b.id);
    const users = await dbAll<{ email: string }>("SELECT email FROM users WHERE id = ?", a.id);
    expect(users[0]?.email).toBe("x@privaterelay.appleid.com");
  });

  it("クライアントシークレットは ES256 のJWT（iss＝チームID、sub＝Services ID、aud＝Apple、5分）", async () => {
    await h.login("apple", uniq());
    const req = h.tokenRequests.at(-1);
    expect(req?.body.get("code_verifier")).toBeNull();
    const secret = req?.body.get("client_secret") ?? "";
    const publicKey = await importSPKI(await exportSPKI(h.appleSigningKey.publicKey), "ES256");
    const { payload, protectedHeader } = await jwtVerify(secret, publicKey, {
      currentDate: new Date(h.clock.now),
    });
    expect(protectedHeader).toMatchObject({ alg: "ES256", kid: "KEYID12345" });
    expect(payload).toMatchObject({ iss: "TEAMID1234", sub: "jp.kokohima.test", aud: "https://appleid.apple.com" });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  it("フォームで直接届いた id_token は使わない（トークンエンドポイントの応答だけを信用する）", async () => {
    const s = await h.start("apple");
    h.setTokenResponder(async () => new Response("error", { status: 400 }));
    const forged = await h.signIdToken("apple", { sub: uniq(), nonce: s.nonce });
    const cb = await h.callback("apple", { code: "x", state: s.state, id_token: forged }, s.binding);
    expect(cb.headers.get("Location")).toBe("/login?error=login_failed");
  });
});

describe("コールバックで拒否する", () => {
  async function failsWith(mutate: (s: Awaited<ReturnType<Harness["start"]>>) => Promise<Response>) {
    const before = await dbAll("SELECT * FROM login_codes");
    const sessionsBefore = await dbAll("SELECT * FROM sessions");
    const s = await h.start("google");
    const res = await mutate(s);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login?error=login_failed");
    const after = await dbAll("SELECT * FROM login_codes");
    expect(after.length).toBe(before.length);
    expect((await dbAll("SELECT * FROM sessions")).length).toBe(sessionsBefore.length);
  }

  const ok = (s: { nonce: string }) => h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce }));

  it("state が一致しない", () =>
    failsWith(async (s) => {
      ok(s);
      return h.callback("google", { code: "x", state: "wrong" }, s.binding);
    }));

  it("state の再使用", async () => {
    const s = await h.start("google");
    ok(s);
    const first = await h.callback("google", { code: "x", state: s.state }, s.binding);
    expect(completeCodeFrom(first)).toBeTruthy();
    const second = await h.callback("google", { code: "x", state: s.state }, s.binding);
    expect(second.headers.get("Location")).toBe("/login?error=login_failed");
  });

  it("期限切れの state（10分）", () =>
    failsWith(async (s) => {
      ok(s);
      h.clock.now += 10 * 60 * 1000 + 1;
      return h.callback("google", { code: "x", state: s.state }, s.binding);
    }));

  it("別のプロバイダで始めた state", async () => {
    const s = await h.start("apple");
    ok(s);
    const res = await h.callback("google", { code: "x", state: s.state }, s.binding);
    expect(res.headers.get("Location")).toBe("/login?error=login_failed");
  });

  it("結びつけCookieがない", () =>
    failsWith(async (s) => {
      ok(s);
      return h.callback("google", { code: "x", state: s.state });
    }));

  it("結びつけCookieが別のブラウザの値", () =>
    failsWith(async (s) => {
      ok(s);
      const other = await h.start("google");
      return h.callback("google", { code: "x", state: s.state }, other.binding);
    }));

  it("プロバイダが error を返した（キャンセルなど）", () =>
    failsWith(async (s) => h.callback("google", { error: "access_denied", state: s.state }, s.binding)));

  it("IDトークンの署名が不正（別の鍵）", () =>
    failsWith(async (s) => {
      const other = await generateKeyPair("RS256");
      h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce }, { key: other.privateKey }));
      return h.callback("google", { code: "x", state: s.state }, s.binding);
    }));

  it("IDトークンの alg が RS256 以外", () =>
    failsWith(async (s) => {
      const hs = new TextEncoder().encode("x".repeat(32));
      h.respondWithIdToken(async () =>
        new SignJWT({ iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, sub: uniq(), nonce: s.nonce })
          .setProtectedHeader({ alg: "HS256", kid: "google-kid" })
          .setIssuedAt()
          .setExpirationTime("10m")
          .sign(hs),
      );
      return h.callback("google", { code: "x", state: s.state }, s.binding);
    }));

  it("発行者が違う", () =>
    failsWith(async (s) => {
      h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce, iss: "https://evil.example" }));
      return h.callback("google", { code: "x", state: s.state }, s.binding);
    }));

  it("宛先が違う", () =>
    failsWith(async (s) => {
      h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce, aud: "someone-else" }));
      return h.callback("google", { code: "x", state: s.state }, s.binding);
    }));

  it("期限切れ", () =>
    failsWith(async (s) => {
      const past = Math.floor(h.clock.now / 1000) - 3600;
      h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce, iat: past, exp: past + 600 }));
      return h.callback("google", { code: "x", state: s.state }, s.binding);
    }));

  it("nonce が一致しない", () =>
    failsWith(async (s) => {
      h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: "other-nonce" }));
      return h.callback("google", { code: "x", state: s.state }, s.binding);
    }));
});

describe("ログインの完了", () => {
  async function codeFor() {
    const s = await h.start("google");
    h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce }));
    const cb = await h.callback("google", { code: "x", state: s.state }, s.binding);
    return { code: completeCodeFrom(cb) ?? "", binding: s.binding };
  }

  async function expectUnauthenticated(res: Response) {
    expect(res.status).toBe(401);
    expect(problemSchema.parse(await res.json()).code).toBe("unauthenticated");
    expect(cookieValue(res, "__Host-kh_rt")).toBeUndefined();
  }

  it("完了コードは1回だけ使える", async () => {
    const { code, binding } = await codeFor();
    expect((await h.complete(code, binding)).status).toBe(200);
    await expectUnauthenticated(await h.complete(code, binding));
  });

  it("完了コードは60秒で失効する（409ではなく401）", async () => {
    const { code, binding } = await codeFor();
    h.clock.now += 60 * 1000 + 1;
    await expectUnauthenticated(await h.complete(code, binding));
  });

  it("Origin がない・別のOriginは401", async () => {
    const a = await codeFor();
    await expectUnauthenticated(await h.complete(a.code, a.binding, null));
    const b = await codeFor();
    await expectUnauthenticated(await h.complete(b.code, b.binding, "https://evil.example"));
  });

  it("結びつけCookieがない・別のブラウザの値なら401（ログインCSRF）", async () => {
    const a = await codeFor();
    await expectUnauthenticated(await h.complete(a.code));
    const b = await codeFor();
    const other = await h.start("google");
    await expectUnauthenticated(await h.complete(b.code, other.binding));
  });

  it("完了したら結びつけCookieを消す", async () => {
    const { code, binding } = await codeFor();
    const res = await h.complete(code, binding);
    expect(cookieValue(res, "__Host-kh_oauth")).toBe("");
  });
});

describe("更新", () => {
  it("交換すると古いトークンは使えなくなり、新しいトークンで続けられる", async () => {
    const r = await h.login("google", uniq());
    const first = await h.refresh(r.refreshToken);
    expect(first.status).toBe(200);
    const next = cookieValue(first, "__Host-kh_rt") ?? "";
    expect(next).not.toBe(r.refreshToken);
    const body = (await first.json()) as { accessToken: string };
    expect((await me(body.accessToken)).status).toBe(200);
    expect((await h.refresh(next)).status).toBe(200);
  });

  it("応答が届かなかった場合：古いトークンが来ても、次のトークンが未使用なら救済する（時間がたっていても）", async () => {
    const r = await h.login("google", uniq());
    const lost = await h.refresh(r.refreshToken);
    expect(lost.status).toBe(200); // この応答のCookieはブラウザに届かなかったとする
    h.clock.now += 6 * 60 * 60 * 1000;
    const retry = await h.refresh(r.refreshToken);
    expect(retry.status).toBe(200);
    // 救済で受け取ったトークンで続けられる
    expect((await h.refresh(cookieValue(retry, "__Host-kh_rt"))).status).toBe(200);
  });

  it.each([0, 1])(
    "同時に2回使われても、どちらの応答のCookieが残っても続けられる（残したのは %i 番目）",
    async (keep) => {
      const r = await h.login("google", uniq());
      const responses = await Promise.all([h.refresh(r.refreshToken), h.refresh(r.refreshToken)]);
      expect(responses.map((res) => res.status)).toEqual([200, 200]);
      const kept = cookieValue(responses[keep] as Response, "__Host-kh_rt");
      const next = await h.refresh(kept);
      expect(next.status).toBe(200);
      expect((await h.refresh(cookieValue(next, "__Host-kh_rt"))).status).toBe(200);
    },
  );

  it("全端末ログアウトの後は、失効前に読んだトークンでも交換しない", async () => {
    const r = await h.login("google", uniq());
    const logoutAll = h.request("/api/v1/auth/logout-all", {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${r.accessToken}` },
    });
    const [, refreshed] = await Promise.all([logoutAll, h.refresh(r.refreshToken)]);
    // 同時に走った更新が先に終わっていても、その後のトークンはもう使えない
    if (refreshed.status === 200) {
      expect((await h.refresh(cookieValue(refreshed, "__Host-kh_rt"))).status).toBe(401);
    } else {
      expect(refreshed.status).toBe(401);
    }
  });

  it("再利用：盗まれた古いトークンの後に正規の利用者が更新すると、系列のすべてのトークンが使えなくなる", async () => {
    const r = await h.login("google", uniq());
    const legit1 = await h.refresh(r.refreshToken);
    const legitToken = cookieValue(legit1, "__Host-kh_rt") ?? "";
    const legit2 = await h.refresh(legitToken);
    const latest = cookieValue(legit2, "__Host-kh_rt") ?? "";
    // 2世代前のトークン（次のトークンも使用済み）が使われた
    const stolen = await h.refresh(r.refreshToken);
    expect(stolen.status).toBe(401);
    expect(cookieValue(stolen, "__Host-kh_rt")).toBe("");
    expect((await h.refresh(latest)).status).toBe(401);
  });

  it("再利用：盗んだ側が先に更新し、正規の利用者・盗んだ側の順に更新すると、系列ごと失効する", async () => {
    const r = await h.login("google", uniq());
    const attacker1 = await h.refresh(r.refreshToken); // 盗んだ側が先に使う
    expect(attacker1.status).toBe(200);
    const legit = await h.refresh(r.refreshToken); // 正規の利用者は救済される
    expect(legit.status).toBe(200);
    // 盗んだ側のトークンは救済で使用済みにされている。提示されたら再利用として失効させる
    const attacker2 = await h.refresh(cookieValue(attacker1, "__Host-kh_rt"));
    expect(attacker2.status).toBe(401);
    expect((await h.refresh(cookieValue(legit, "__Host-kh_rt"))).status).toBe(401);
  });

  it("Originなし・別のOriginは401", async () => {
    const r = await h.login("google", uniq());
    expect((await h.refresh(r.refreshToken, null)).status).toBe(401);
    expect((await h.refresh(r.refreshToken, "https://evil.example")).status).toBe(401);
    // 拒否されたトークンは消費されていない
    expect((await h.refresh(r.refreshToken)).status).toBe(200);
  });

  it("トークンの期限切れ（30日）は401", async () => {
    const r = await h.login("google", uniq());
    h.clock.now += 30 * 24 * 60 * 60 * 1000;
    expect((await h.refresh(r.refreshToken)).status).toBe(401);
  });

  it("セッションの絶対期限（90日）を過ぎると、使い続けていても401", async () => {
    const r = await h.login("google", uniq());
    let token = r.refreshToken;
    for (let i = 0; i < 4; i++) {
      h.clock.now += 25 * 24 * 60 * 60 * 1000;
      const res = await h.refresh(token);
      if (i < 3) {
        expect(res.status).toBe(200);
        token = cookieValue(res, "__Host-kh_rt") ?? "";
      } else {
        expect(res.status).toBe(401);
      }
    }
  });

  it("Cookieがない・知らないトークンは401", async () => {
    expect((await h.refresh(undefined)).status).toBe(401);
    expect((await h.refresh("unknown-token")).status).toBe(401);
  });
});

describe("ログアウト", () => {
  it("そのセッションだけを失効させる", async () => {
    const sub = uniq();
    const a = await h.login("google", sub);
    const b = await h.login("google", sub);
    const res = await h.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: `__Host-kh_rt=${a.refreshToken}` },
    });
    expect(res.status).toBe(204);
    expect(cookieValue(res, "__Host-kh_rt")).toBe("");
    expect((await h.refresh(a.refreshToken)).status).toBe(401);
    expect((await h.refresh(b.refreshToken)).status).toBe(200);
  });

  it("Cookieがなくても204。Originが違えば401", async () => {
    const ok = await h.request("/api/v1/auth/logout", { method: "POST", headers: { Origin: ORIGIN } });
    expect(ok.status).toBe(204);
    const ng = await h.request("/api/v1/auth/logout", { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(ng.status).toBe(401);
  });
});

describe("全端末ログアウト", () => {
  const logoutAll = (accessToken: string, origin = ORIGIN) =>
    h.request("/api/v1/auth/logout-all", {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
    });

  it("全セッションが失効し、どの更新用トークンも使えない。他のユーザーには影響しない", async () => {
    const sub = uniq();
    const a1 = await h.login("google", sub);
    const a2 = await h.login("apple", sub); // 別のプロバイダは別ユーザー
    const a3 = await h.login("google", sub);
    const other = await h.login("google", uniq());
    expect((await logoutAll(a1.accessToken)).status).toBe(204);
    expect((await h.refresh(a1.refreshToken)).status).toBe(401);
    expect((await h.refresh(a3.refreshToken)).status).toBe(401);
    expect((await h.refresh(a2.refreshToken)).status).toBe(200);
    expect((await h.refresh(other.refreshToken)).status).toBe(200);
  });

  it("失効後のアクセストークンでは、もう一度 logout-all できない（requireActiveSession）", async () => {
    const r = await h.login("google", uniq());
    expect((await logoutAll(r.accessToken)).status).toBe(204);
    expect((await logoutAll(r.accessToken)).status).toBe(401);
  });

  it("Originが違えば401", async () => {
    const r = await h.login("google", uniq());
    expect((await logoutAll(r.accessToken, "https://evil.example")).status).toBe(401);
  });
});

describe("認証ミドルウェアと /me", () => {
  it("他人のIDを query や body で指定しても、Bearer の本人だけを返す", async () => {
    const a = await h.login("google", uniq());
    const b = await h.login("google", uniq());
    const bId = meResponseSchema.parse(await (await me(b.accessToken)).json()).id;
    const res = await h.request(`/api/v1/me?userId=${bId}&id=${bId}`, {
      headers: { Authorization: `Bearer ${a.accessToken}` },
    });
    const body = meResponseSchema.parse(await res.json());
    expect(body.id).not.toBe(bId);
    expect(Object.keys(body).sort()).toEqual(["avatarUrl", "displayName", "id"]);
  });

  async function rejectsWithSameResponse(authorization: string | undefined) {
    const res = await h.request("/api/v1/me", { headers: authorization ? { Authorization: authorization } : {} });
    expect(res.status).toBe(401);
    const body = problemSchema.parse(await res.json());
    expect(body).toMatchObject({ code: "unauthenticated", title: "Unauthorized", status: 401 });
  }

  it("トークンなし・壊れた値は同じ401", async () => {
    await rejectsWithSameResponse(undefined);
    await rejectsWithSameResponse("Bearer not-a-jwt");
    await rejectsWithSameResponse("Basic abc");
  });

  it("期限切れ（10分）は401", async () => {
    const r = await h.login("google", uniq());
    h.clock.now += 10 * 60 * 1000 + 31 * 1000;
    await rejectsWithSameResponse(`Bearer ${r.accessToken}`);
  });

  it("署名不正・未知の kid・alg=none を拒否する", async () => {
    const r = await h.login("google", uniq());
    const [header, payload] = r.accessToken.split(".");
    await rejectsWithSameResponse(`Bearer ${header}.${payload}.AAAA`);

    const claims = JSON.parse(atob((payload ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    const wrongKey = new TextEncoder().encode("w".repeat(32));
    const unknownKid = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: "nope" }).sign(wrongKey);
    await rejectsWithSameResponse(`Bearer ${unknownKid}`);

    const none = `${btoa(JSON.stringify({ alg: "none", kid: "test-1" })).replace(/=+$/, "")}.${payload}.`;
    await rejectsWithSameResponse(`Bearer ${none}`);
  });

  it("鍵の切り替え：古い kid の鍵で署名されたトークンも、鍵が残っていれば受け付ける", async () => {
    const r = await h.login("google", uniq());
    const claims = JSON.parse(atob((r.accessToken.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    const oldKey = Uint8Array.from(atob("b2xkLWtleS1vbGQta2V5LW9sZC1rZXktb2xkLWtleS1vbGQ="), (c) => c.charCodeAt(0));
    const token = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: "test-old" }).sign(oldKey);
    expect((await me(token)).status).toBe(200);
  });
});
