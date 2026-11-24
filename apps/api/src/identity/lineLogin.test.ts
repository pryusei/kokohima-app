import { env } from "cloudflare:workers";
import { meResponseSchema } from "@kokohima/shared";
import { SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeCodeFrom, cookieHeader, createHarness, ORIGIN } from "../../test/identity-harness";
import { providerEnabled } from "./application/auth";
import { REAUTH_WINDOW_MS } from "./application/withdrawal";

// LINE ログイン（docs/specs/T-32-line-login.md）。LINE の token・verify のエンドポイントは偽物に差し替える

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

const uniq = () => `U${crypto.randomUUID().replace(/-/g, "")}`;

async function dbAll<T>(query: string, ...params: unknown[]) {
  return (await env.DB.prepare(query).bind(...params).all<T>()).results;
}

async function me(accessToken: string, path = "/api/v1/me") {
  return h.request(path, { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function meId(accessToken: string) {
  return meResponseSchema.parse(await (await me(accessToken)).json()).id;
}

describe("LINE：ログインの開始", () => {
  it("LINE の認可画面へ、scope=openid・state・nonce・PKCE（S256）つきで送り、結びつけCookie（Lax）を設定する", async () => {
    const s = await h.start("line", "/friends");
    expect(s.res.status).toBe(302);
    expect(s.location.origin + s.location.pathname).toBe("https://access.line.me/oauth2/v2.1/authorize");
    const q = s.location.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(env.LINE_CHANNEL_ID);
    expect(q.get("scope")).toBe("openid");
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/api/v1/auth/line/callback`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(s.state).toHaveLength(43);
    expect(s.nonce).toHaveLength(43);
    // チャネルシークレットは認可画面の URL に出さない
    expect(s.location.toString()).not.toContain(env.LINE_CHANNEL_SECRET ?? "unset");
    const cookie = cookieHeader(s.res, "__Host-kh_oauth") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});

describe("LINE：ログイン", () => {
  it("初回は利用者と対応づけ（provider=line）を作り、2回目は同じ利用者になる。メールアドレスは持たない", async () => {
    const sub = uniq();
    const first = await h.login("line", sub);
    const second = await h.login("line", sub);
    const id = await meId(first.accessToken);
    expect(await meId(second.accessToken)).toBe(id);
    expect(await dbAll("SELECT * FROM user_identities WHERE provider = 'line' AND subject = ?", sub)).toHaveLength(1);
    expect((await dbAll<{ email: string | null }>("SELECT email FROM users WHERE id = ?", id))[0]?.email).toBeNull();
  });

  it("IDトークンにメールアドレスが入っていても保存しない（email のスコープは求めていない）", async () => {
    const r = await h.login("line", uniq(), { email: "line@example.com", email_verified: true });
    const id = await meId(r.accessToken);
    expect((await dbAll<{ email: string | null }>("SELECT email FROM users WHERE id = ?", id))[0]?.email).toBeNull();
  });

  it("トークンのエンドポイントに code_verifier・チャネル ID・チャネルシークレットを送り、verify に IDトークン・チャネル ID・nonce を送る", async () => {
    const s = await h.start("line");
    h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce }));
    const cb = await h.callback("line", { code: "auth-code", state: s.state }, s.binding);
    expect(completeCodeFrom(cb)).toBeTruthy();
    const token = h.tokenRequests.at(-1);
    expect(token?.provider).toBe("line");
    expect(token?.body.get("grant_type")).toBe("authorization_code");
    expect(token?.body.get("code")).toBe("auth-code");
    expect(token?.body.get("code_verifier")).toBeTruthy();
    expect(token?.body.get("client_id")).toBe(env.LINE_CHANNEL_ID);
    expect(token?.body.get("client_secret")).toBe(env.LINE_CHANNEL_SECRET);
    expect(token?.body.get("redirect_uri")).toBe(`${ORIGIN}/api/v1/auth/line/callback`);
    const verify = h.verifyRequests.at(-1);
    expect(verify?.get("id_token")).toBeTruthy();
    expect(verify?.get("client_id")).toBe(env.LINE_CHANNEL_ID);
    expect(verify?.get("nonce")).toBe(s.nonce);
  });

  it("Google と LINE で同じ sub でも別の利用者になる（アカウントは統合しない。#45）", async () => {
    const sub = uniq();
    const google = await h.login("google", sub, { email: "g@example.com", email_verified: true });
    const line = await h.login("line", sub);
    expect(await meId(google.accessToken)).not.toBe(await meId(line.accessToken));
  });

  it("SessionStarted の provider は line", async () => {
    const r = await h.login("line", uniq());
    const id = await meId(r.accessToken);
    const rows = await dbAll<{ payload: string }>(
      "SELECT payload FROM outbox WHERE type = 'SessionStarted' AND json_extract(payload, '$.userId') = ?",
      id,
    );
    expect(rows.map((row) => JSON.parse(row.payload).provider)).toEqual(["line"]);
  });

  it("他人のIDでは取得できない：LINE の利用者のトークンでは、query に他人の ID を付けても本人だけが返る", async () => {
    const a = await h.login("line", uniq());
    const b = await h.login("line", uniq());
    const bId = await meId(b.accessToken);
    const res = await me(a.accessToken, `/api/v1/me?id=${bId}&userId=${bId}`);
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(await res.json());
    expect(body.id).not.toBe(bId);
    expect(body.id).toBe(await meId(a.accessToken));
  });

  it("退会でログインし直しを求めるときは LINE を返す", async () => {
    const r = await h.login("line", uniq());
    h.clock.now += REAUTH_WINDOW_MS + 1;
    const refreshed = await h.refresh(r.refreshToken);
    const token = ((await refreshed.json()) as { accessToken: string }).accessToken;
    const res = await h.request("/api/v1/me/withdrawal", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "withdraw" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "reauth_required", reauthProvider: "line" });
  });
});

describe("LINE：コールバックで拒否する", () => {
  /** 失敗の理由によらず /login?error=login_failed で、完了コードもセッションも作らない */
  async function failsWith(mutate: (s: Awaited<ReturnType<Harness["start"]>>) => Promise<Response>) {
    const codes = (await dbAll("SELECT * FROM login_codes")).length;
    const sessions = (await dbAll("SELECT * FROM sessions")).length;
    const s = await h.start("line");
    const res = await mutate(s);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login?error=login_failed");
    expect((await dbAll("SELECT * FROM login_codes")).length).toBe(codes);
    expect((await dbAll("SELECT * FROM sessions")).length).toBe(sessions);
  }
  const respondWith = (claims: (s: { nonce: string }) => Record<string, unknown>) => (s: { nonce: string }) =>
    h.respondWithIdToken((p) => h.signIdToken(p, claims(s)));
  const cb = (s: { state: string; binding: string }) => h.callback("line", { code: "x", state: s.state }, s.binding);

  it("署名が不正（verify が 400）", () =>
    failsWith(async (s) => {
      h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce }, { key: new TextEncoder().encode("other-secret") }));
      return cb(s);
    }));

  it("verify のエンドポイントに届かない", () =>
    failsWith(async (s) => {
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce }))(s);
      h.setVerifyResponder(async () => {
        throw new TypeError("network");
      });
      return cb(s);
    }));

  it("verify が 5xx", () =>
    failsWith(async (s) => {
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce }))(s);
      h.setVerifyResponder(async () => new Response("oops", { status: 503 }));
      return cb(s);
    }));

  it("発行者が違う", () =>
    failsWith(async (s) => {
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce, iss: "https://evil.example" }))(s);
      return cb(s);
    }));

  it("宛先が別のチャネル", () =>
    failsWith(async (s) => {
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce, aud: "9999999999" }))(s);
      return cb(s);
    }));

  it("宛先が配列（チャネル ID を含んでも受け付けない）", () =>
    failsWith(async (s) => {
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce, aud: [env.LINE_CHANNEL_ID] }))(s);
      return cb(s);
    }));

  it("期限切れ（許容の60秒を過ぎた）", () =>
    failsWith(async (s) => {
      const past = Math.floor(h.clock.now / 1000) - 3600;
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce, iat: past, exp: Math.floor(h.clock.now / 1000) - 61 }))(s);
      return cb(s);
    }));

  it("nonce が一致しない・ない", async () => {
    await failsWith(async (s) => {
      respondWith(() => ({ sub: uniq(), nonce: "other-nonce" }))(s);
      return cb(s);
    });
    await failsWith(async (s) => {
      respondWith(() => ({ sub: uniq() }))(s);
      return cb(s);
    });
  });

  it("sub がない・長すぎる", async () => {
    await failsWith(async (s) => {
      respondWith((x) => ({ nonce: x.nonce }))(s);
      return cb(s);
    });
    await failsWith(async (s) => {
      respondWith((x) => ({ sub: "U".repeat(256), nonce: x.nonce }))(s);
      return cb(s);
    });
  });

  it("トークンのエンドポイントがエラー・IDトークンがない", async () => {
    await failsWith(async (s) => {
      h.setTokenResponder(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
      return cb(s);
    });
    await failsWith(async (s) => {
      h.setTokenResponder(async () => Response.json({ access_token: "a", token_type: "Bearer" }));
      return cb(s);
    });
  });

  it("LINE が error を返した（キャンセルなど）", () =>
    failsWith(async (s) => h.callback("line", { error: "access_denied", state: s.state }, s.binding)));

  it("Google で始めた state を LINE のコールバックに使う", async () => {
    const s = await h.start("google");
    h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce }));
    const res = await h.callback("line", { code: "x", state: s.state }, s.binding);
    expect(res.headers.get("Location")).toBe("/login?error=login_failed");
  });

  it("結びつけCookieがない・別のブラウザの値", async () => {
    await failsWith(async (s) => {
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce }))(s);
      return h.callback("line", { code: "x", state: s.state });
    });
    await failsWith(async (s) => {
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce }))(s);
      const other = await h.start("line");
      return h.callback("line", { code: "x", state: s.state }, other.binding);
    });
  });

  it("verify の応答だけを信じる：IDトークンの中身が正しくても verify が別の nonce を返せば失敗", () =>
    failsWith(async (s) => {
      respondWith((x) => ({ sub: uniq(), nonce: x.nonce }))(s);
      const iat = Math.floor(h.clock.now / 1000);
      h.setVerifyResponder(async () =>
        Response.json({ iss: "https://access.line.me", aud: env.LINE_CHANNEL_ID, sub: uniq(), iat, exp: iat + 600, nonce: "different" }),
      );
      return cb(s);
    }));

  it("ログには失敗の種類だけを出し、IDトークン・認可コードを出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = await h.start("line");
      const forged = await new SignJWT({ sub: uniq(), nonce: s.nonce })
        .setProtectedHeader({ alg: "HS256" })
        .sign(new TextEncoder().encode("x".repeat(32)));
      h.setTokenResponder(async () => Response.json({ id_token: forged }));
      const res = await h.callback("line", { code: "secret-auth-code", state: s.state }, s.binding);
      expect(res.headers.get("Location")).toBe("/login?error=login_failed");
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain('"provider":"line"');
      expect(logged).toContain('"reason":"id_token_invalid"');
      expect(logged).not.toContain(forged);
      expect(logged).not.toContain("secret-auth-code");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("LINE：止めた環境（チャネル ID かシークレットがない）", () => {
  it("両方があるときだけ使える", () => {
    expect(providerEnabled(h.bindings, "line")).toBe(true);
    for (const missing of [{ LINE_CHANNEL_ID: "" }, { LINE_CHANNEL_SECRET: "" }, { LINE_CHANNEL_ID: undefined }, { LINE_CHANNEL_SECRET: undefined }]) {
      expect(providerEnabled({ ...h.bindings, ...missing }, "line"), JSON.stringify(missing)).toBe(false);
    }
  });

  it("開始はログインの失敗へ戻し、ログインの記録も結びつけCookieも作らない", async () => {
    h.bindings.LINE_CHANNEL_SECRET = "";
    const before = (await dbAll("SELECT * FROM oauth_transactions")).length;
    const res = await h.request("/api/v1/auth/line/start");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login?error=login_failed");
    expect(cookieHeader(res, "__Host-kh_oauth") ?? "").not.toMatch(/__Host-kh_oauth=[^;]+;.*Max-Age=600/);
    expect((await dbAll("SELECT * FROM oauth_transactions")).length).toBe(before);
  });

  it("コールバックも失敗にする（始めたあとで止めても完了コードを作らない）", async () => {
    const s = await h.start("line");
    h.respondWithIdToken((p) => h.signIdToken(p, { sub: uniq(), nonce: s.nonce }));
    h.bindings.LINE_CHANNEL_ID = "";
    const res = await h.callback("line", { code: "x", state: s.state }, s.binding);
    expect(res.headers.get("Location")).toBe("/login?error=login_failed");
    expect(h.verifyRequests).toHaveLength(0);
  });
});
