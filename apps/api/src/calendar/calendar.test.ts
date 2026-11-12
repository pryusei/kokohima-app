import { env } from "cloudflare:workers";
import { calendarConnectionsSchema, freeSlotsSchema, icsLinkSchema } from "@kokohima/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieValue, createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { handleJob } from "../jobs/consumer";
import { dispatchOutbox } from "../jobs/dispatch";
import { runScheduled } from "../worker";
import { syncConnection } from "./application/sync";

// カレンダー連携（docs/specs/T-06-calendar.md）。時計は 2026-10-10T00:00:00Z（土曜、東京は 09:00）

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

let people: User[] = [];

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
  people = [];
});

/** 時計を進め、作った利用者全員のアクセストークンを取り直す */
const tick = (ms: number) => u.advance(ms, ...people);

const MIN = 60 * 1000;
const T = (s: string, day = "10") => `2026-10-${day}T${s}:00.000Z`;
const ms = (s: string, day = "10") => Date.parse(T(s, day));

async function authorize(who: User) {
  const res = await u.call("POST", "/api/v1/calendar/google/authorizations", { token: who.token });
  expect(res.status).toBe(200);
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const url = new URL(authorizeUrl);
  return { res, url, state: url.searchParams.get("state") ?? "", binding: cookieValue(res, "__Host-kh_cal") ?? "" };
}

function callback(params: Record<string, string>, binding?: string) {
  const headers: Record<string, string> = binding ? { Cookie: `__Host-kh_cal=${binding}` } : {};
  return h.request(`/api/v1/calendar/google/callback?${new URLSearchParams(params)}`, { headers });
}

async function connect(who: User) {
  const a = await authorize(who);
  const res = await callback({ code: "auth-code", state: a.state }, a.binding);
  expect(res.headers.get("Location")).toBe("https://app.test/settings/calendar?calendar=connected");
}

const connectionRow = (who: User) =>
  env.DB.prepare("SELECT * FROM calendar_connections WHERE user_id = ?1 AND provider = 'google'")
    .bind(who.id)
    .first<{ status: string; refresh_token_enc: string | null; calendar_id: string | null; busy_snapshot: string | null; large_change_held: number }>();

const status = async (who: User) =>
  calendarConnectionsSchema.parse(await (await u.call("GET", "/api/v1/calendar/connections", { token: who.token })).json());

/** テストの間で DB は共有されるので、関係する ID を含むイベントだけを読む */
async function outbox(type: string, id: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, payload, processed_at FROM outbox WHERE type = ? AND payload LIKE ? ORDER BY created_at, rowid",
  )
    .bind(type, `%${id}%`)
    .all<{ id: string; payload: string; processed_at: number | null }>();
  return results.map(
    (r): Record<string, unknown> & { id: string; processedAt: number | null } => ({
      ...(JSON.parse(r.payload) as Record<string, unknown>),
      id: r.id,
      processedAt: r.processed_at,
    }),
  );
}

/** outbox の行を consumer に直接渡す（Queue を通さない） */
async function deliver(type: string, id: string) {
  for (const e of await outbox(type, id)) {
    const row = await env.DB.prepare("SELECT payload FROM outbox WHERE id = ?1").bind(e.id).first<{ payload: string }>();
    await handleJob(h.ctx, { kind: "outbox", id: e.id, type, payload: row?.payload ?? "{}" });
  }
}

const busy = (start: string, end: string) => ({ start, end });

describe("連携の開始", () => {
  it("authorizeUrl のパラメータと結びつけCookie", async () => {
    const a = await authenticated();
    const { url, res } = await authorize(a);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.app.created",
    );
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBeTruthy();
    expect(p.get("redirect_uri")).toBe("https://app.test/api/v1/calendar/google/callback");
    expect(p.has("include_granted_scopes")).toBe(false);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/__Host-kh_cal=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=600/);
  });

  it("10分に10回まで。11回目は429と Retry-After（同時に送っても超えない）", async () => {
    const a = await authenticated();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => u.call("POST", "/api/v1/calendar/google/authorizations", { token: a.token })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    const limited = results.find((r) => r.status === 429);
    expect(limited?.headers.get("Retry-After")).toBe("600");
    h.clock.now += 4 * MIN;
    const again = await u.call("POST", "/api/v1/calendar/google/authorizations", { token: a.token });
    expect(again.status).toBe(429);
    expect(again.headers.get("Retry-After")).toBe("360");
  });

  it("未ログイン・失効したセッションでは401", async () => {
    expect((await u.call("POST", "/api/v1/calendar/google/authorizations")).status).toBe(401);
    const a = await authenticated();
    await u.call("POST", "/api/v1/auth/logout-all", { token: a.token, cookie: `__Host-kh_rt=${a.refreshToken}` });
    expect((await u.call("POST", "/api/v1/calendar/google/authorizations", { token: a.token })).status).toBe(401);
  });
});

/** 表示名つきの利用者 */
async function authenticated(name = "あき") {
  const who = await u.user(name);
  people.push(who);
  return who;
}

describe("コールバック", () => {
  it("成功：暗号化した行と CalendarConnected。更新用トークンは平文で残らない", async () => {
    const a = await authenticated();
    await connect(a);
    const row = await connectionRow(a);
    expect(row?.status).toBe("active");
    expect(row?.refresh_token_enc).toMatch(/^v1\.cal-1\./);
    expect(row?.refresh_token_enc).not.toContain("refresh-");
    const events = await outbox("CalendarConnected", a.id);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(["id", "occurredAt", "processedAt", "provider", "userId"]);
    expect(await status(a)).toEqual({ google: { status: "connected", connectedAt: new Date(h.clock.now).toISOString() } });
  });

  it("失敗はすべて同じ ?calendar=failed（state の使い回し・期限切れ・別のブラウザ・error・スコープ不足）", async () => {
    const a = await authenticated();
    const failed = "https://app.test/settings/calendar?calendar=failed";

    const reused = await authorize(a);
    await callback({ code: "c", state: reused.state }, reused.binding);
    expect((await callback({ code: "c", state: reused.state }, reused.binding)).headers.get("Location")).toBe(failed);

    const expired = await authorize(a);
    h.clock.now += 10 * MIN;
    expect((await callback({ code: "c", state: expired.state }, expired.binding)).headers.get("Location")).toBe(failed);

    const noCookie = await authorize(a);
    expect((await callback({ code: "c", state: noCookie.state })).headers.get("Location")).toBe(failed);
    const otherCookie = await authorize(a);
    expect((await callback({ code: "c", state: otherCookie.state }, "x".repeat(43))).headers.get("Location")).toBe(failed);

    const denied = await authorize(a);
    expect((await callback({ error: "access_denied", state: denied.state }, denied.binding)).headers.get("Location")).toBe(failed);

    expect((await callback({ code: "c" })).headers.get("Location")).toBe(failed);
  });

  it("スコープ不足：連携していなければ受け取ったトークンを失効させる", async () => {
    const a = await authenticated();
    h.google.state.grantedScopes = ["https://www.googleapis.com/auth/calendar.freebusy"];
    const s = await authorize(a);
    const res = await callback({ code: "c", state: s.state }, s.binding);
    expect(res.headers.get("Location")).toBe("https://app.test/settings/calendar?calendar=failed");
    expect(h.google.state.requests.filter((r) => r.path === "/revoke")).toHaveLength(1);
    expect(await connectionRow(a)).toBeNull();
  });

  it("スコープ不足：連携が active なら失効させず、今の連携が残る", async () => {
    const a = await authenticated();
    await connect(a);
    const before = await connectionRow(a);
    h.google.state.grantedScopes = ["https://www.googleapis.com/auth/calendar.freebusy"];
    const s = await authorize(a);
    expect((await callback({ code: "c", state: s.state }, s.binding)).headers.get("Location")).toContain("failed");
    expect(h.google.state.requests.filter((r) => r.path === "/revoke")).toHaveLength(0);
    expect((await connectionRow(a))?.refresh_token_enc).toBe(before?.refresh_token_enc);
    expect((await status(a)).google.status).toBe("connected");
  });

  it("連携し直すと calendar_id が残り、埋まりの記録が消える。古いトークンは失効させない", async () => {
    const a = await authenticated();
    await connect(a);
    await env.DB.prepare(
      "UPDATE calendar_connections SET calendar_id = 'cal-x', busy_snapshot = '[]', snapshot_from = 1, snapshot_to = 2 WHERE user_id = ?1",
    )
      .bind(a.id)
      .run();
    await connect(a);
    const row = await connectionRow(a);
    expect(row?.calendar_id).toBe("cal-x");
    expect(row?.busy_snapshot).toBeNull();
    expect(h.google.state.requests.filter((r) => r.path === "/revoke")).toHaveLength(0);
  });

  it("ログに、コード・トークン・Googleの応答の本文が出ない", async () => {
    const spy = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const a = await authenticated();
    await connect(a);
    const s = await authorize(a);
    await callback({ code: "secret-code", state: s.state });
    const logged = [...spy.mock.calls, ...err.mock.calls].flat().join("\n");
    expect(logged).not.toMatch(/secret-code|refresh-|access-|v1\.cal-1/);
    spy.mockRestore();
    err.mockRestore();
  });
});

describe("状態と解除", () => {
  it("none → connected → 解除で none。revoke を呼び、トークンと記録が消える", async () => {
    const a = await authenticated();
    expect((await status(a)).google).toEqual({ status: "none", connectedAt: null });
    await connect(a);
    const res = await u.call("DELETE", "/api/v1/calendar/connections/google", { token: a.token });
    expect(res.status).toBe(204);
    const revokes = h.google.state.requests.filter((r) => r.path === "/revoke");
    expect(revokes).toHaveLength(1);
    expect(new URLSearchParams(revokes[0]?.body).get("token")).toMatch(/^refresh-/);
    const row = await connectionRow(a);
    expect(row?.status).toBe("disconnected");
    expect(row?.refresh_token_enc).toBeNull();
    expect((await status(a)).google.status).toBe("none");
    expect((await u.call("DELETE", "/api/v1/calendar/connections/google", { token: a.token })).status).toBe(404);
  });

  it("revoke が失敗しても204でトークンが消える", async () => {
    const a = await authenticated();
    await connect(a);
    h.google.state.failNext.set("POST /revoke", 500);
    expect((await u.call("DELETE", "/api/v1/calendar/connections/google", { token: a.token })).status).toBe(204);
    expect((await connectionRow(a))?.refresh_token_enc).toBeNull();
  });

  it("他人の連携は見えず、消せない", async () => {
    const a = await authenticated();
    const b = await authenticated("べに");
    await connect(a);
    expect((await status(b)).google.status).toBe("none");
    expect((await u.call("DELETE", "/api/v1/calendar/connections/google", { token: b.token })).status).toBe(404);
    expect((await connectionRow(a))?.status).toBe("active");
  });

  it("invalid_grant で needs_reauth と CalendarReauthRequired。その後は Google を呼ばない", async () => {
    const a = await authenticated();
    await connect(a);
    for (let n = 0; n <= h.google.state.refreshCounter; n++) h.google.state.revoked.add(`refresh-${n}`);
    const res = await u.call("GET", `/api/v1/calendar/free-slots?from=${T("00:00")}&to=${T("00:00", "13")}`, { token: a.token });
    expect(freeSlotsSchema.parse(await res.json()).status).toBe("needs_reauth");
    expect((await status(a)).google.status).toBe("needs_reauth");
    expect(await outbox("CalendarReauthRequired", a.id)).toHaveLength(1);
    const count = h.google.state.requests.length;
    await u.call("GET", `/api/v1/calendar/free-slots?from=${T("00:00")}&to=${T("00:00", "13")}`, { token: a.token });
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("skipped");
    expect(h.google.state.requests.length).toBe(count);
  });
});

describe("カレンダーの空き（候補）", () => {
  const range = `from=${T("00:00")}&to=${T("00:00", "12")}`;
  const get = async (who: User, q = range) =>
    u.call("GET", `/api/v1/calendar/free-slots?${q}`, { token: who.token });

  it("連携していなければ none", async () => {
    const a = await authenticated();
    expect(freeSlotsSchema.parse(await (await get(a)).json())).toEqual({ status: "none", items: [], nextCursor: null });
  });

  it("プリセットの枠のうち、過去・埋まりと重なる・自分のここ暇と重なる枠を外す。freeBusy は primary だけ", async () => {
    const a = await authenticated();
    await connect(a);
    // 東京の 10/10：昼 11-15（02-06Z）は過去でない（今は 09:00）。夕方 16-19（07-10Z）、夜 19-23（10-14Z）
    h.google.state.busy = [busy(T("08:00"), T("08:30"))];
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "day" } });
    const body = freeSlotsSchema.parse(await (await get(a)).json());
    expect(body.status).toBe("ok");
    expect(body.items.map((i) => `${i.date} ${i.preset}`)).toEqual([
      "2026-10-10 day",
      "2026-10-10 night",
      "2026-10-11 evening",
      "2026-10-11 night",
    ]);
    const fb = h.google.state.requests.filter((r) => r.path.endsWith("/freeBusy"));
    expect(fb).toHaveLength(1);
    const req = JSON.parse(fb[0]?.body ?? "{}") as { items: { id: string }[]; timeMin: string; timeMax: string };
    expect(req.items).toEqual([{ id: "primary" }]);
    expect(req.timeMin).toBe(T("02:00"));
    expect(req.timeMax).toBe(T("14:00", "11"));
  });

  it("くり返しと重なる枠も出さない", async () => {
    const a = await authenticated();
    await connect(a);
    await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 6, preset: "night" } });
    const body = freeSlotsSchema.parse(await (await get(a, `from=${T("00:00")}&to=${T("00:00", "11")}`)).json());
    expect(body.items.map((i) => i.preset)).toEqual(["day", "evening"]);
  });

  it("Google の失敗・エラー付きの200・primary がないときは unavailable", async () => {
    const a = await authenticated();
    await connect(a);
    h.google.state.failNext.set("POST /calendar/v3/freeBusy", 500);
    expect(freeSlotsSchema.parse(await (await get(a)).json()).status).toBe("unavailable");
    h.google.state.freeBusyOverride = () =>
      Response.json({ calendars: { primary: { errors: [{ domain: "global", reason: "internalError" }], busy: [] } } });
    expect(freeSlotsSchema.parse(await (await get(a)).json()).status).toBe("unavailable");
    h.google.state.freeBusyOverride = () => Response.json({ calendars: {} });
    expect(freeSlotsSchema.parse(await (await get(a)).json()).status).toBe("unavailable");
  });

  it("14日を超える範囲・壊れた範囲は400。未ログインは401", async () => {
    const a = await authenticated();
    expect((await get(a, `from=${T("00:00")}&to=${T("00:01", "24")}`)).status).toBe(400);
    expect((await get(a, `from=${T("00:00", "12")}&to=${T("00:00")}`)).status).toBe(400);
    expect((await u.call("GET", `/api/v1/calendar/free-slots?${range}`)).status).toBe(401);
  });

  it("候補の取得で埋まりを保存しない", async () => {
    const a = await authenticated();
    await connect(a);
    h.google.state.busy = [busy(T("08:00"), T("08:30"))];
    await get(a);
    expect((await connectionRow(a))?.busy_snapshot).toBeNull();
  });
});

describe("定期の確認と自動取り消し", () => {
  /** A が連携して最初の確認（記録だけ）を終える。その前に作った枠が「前回の確認より前」になるよう1分進める */
  async function synced(who: User) {
    await u.advance(MIN, who);
    await connect(who);
    expect(await syncConnection(h.ctx, who.id, "google")).toBe("recorded");
  }

  const myItems = async (who: User) => {
    const res = await u.call("GET", `/api/v1/availabilities?from=${T("00:00")}&to=2026-11-05T00:00:00.000Z`, { token: who.token });
    return ((await res.json()) as { items: { source: string; id: string; date: string | null; startsAt: string }[] }).items;
  };

  it("連携した直後の確認は記録だけで、ここ暇を取り消さない", async () => {
    const a = await authenticated();
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11"))];
    await synced(a);
    expect(await myItems(a)).toHaveLength(1);
    const row = await connectionRow(a);
    expect(JSON.parse(row?.busy_snapshot ?? "null")).toEqual([[ms("11:00", "11"), ms("12:00", "11")]]);
  });

  it("新しく入った埋まりと重なる手動の枠を削除し、くり返しはその日を例外に足す。イベントは1つにまとめる", async () => {
    const a = await authenticated();
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-12", preset: "night" } });
    // 10/17（土）の夜のくり返し
    await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 6, preset: "night" } });
    await synced(a);
    await tick(15 * MIN);
    h.google.state.busy = [busy(T("11:00", "11"), T("11:30", "11")), busy(T("12:00", "17"), T("13:00", "17"))];
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("synced");
    const items = await myItems(a);
    expect(items.some((i) => i.source === "manual" && i.startsAt === T("10:00", "11"))).toBe(false);
    expect(items.some((i) => i.source === "manual" && i.startsAt === T("10:00", "12"))).toBe(true);
    expect(items.some((i) => i.source === "recurrence" && i.date === "2026-10-17")).toBe(false);
    expect(items.some((i) => i.source === "recurrence" && i.date === "2026-10-10")).toBe(true);
    const events = await outbox("AvailabilityCancelledByCalendar", a.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.ranges).toEqual([
      { startsAt: T("10:00", "11"), endsAt: T("14:00", "11") },
      { startsAt: T("10:00", "17"), endsAt: T("14:00", "17") },
    ]);
    // 同じ埋まりの次の確認では何も起きない
    await tick(15 * MIN);
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("synced");
    expect(await outbox("AvailabilityCancelledByCalendar", a.id)).toHaveLength(1);
  });

  it("前回の確認の後に作った枠・ルールは取り消さない（予定を見たうえで作った）", async () => {
    const a = await authenticated();
    await synced(a);
    await tick(5 * MIN);
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 6, preset: "night" } });
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11")), busy(T("11:00", "17"), T("12:00", "17"))];
    await tick(10 * MIN);
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("synced");
    expect((await myItems(a)).filter((i) => i.startsAt === T("10:00", "11") || i.date === "2026-10-17")).toHaveLength(2);
    expect(await outbox("AvailabilityCancelledByCalendar", a.id)).toHaveLength(0);
  });

  it("終わった枠は対象外。埋まりと接するだけの枠も対象外", async () => {
    const a = await authenticated();
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { startsAt: T("01:00"), endsAt: T("02:00") } });
    await synced(a);
    h.clock.now = ms("01:30");
    h.google.state.busy = [busy(T("00:00"), T("01:00")), busy(T("02:00"), T("03:00"))];
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("synced");
    expect(await outbox("AvailabilityCancelledByCalendar", a.id)).toHaveLength(0);
  });

  it("freeBusy がエラー付きの200・失敗なら、記録を更新せず何も取り消さず、権利を戻して投げる", async () => {
    const a = await authenticated();
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    h.google.state.busy = [busy(T("01:00", "20"), T("02:00", "20"))];
    await synced(a);
    const before = await connectionRow(a);
    h.google.state.freeBusyOverride = () =>
      Response.json({ calendars: { primary: { errors: [{ domain: "global", reason: "backendError" }], busy: [] } } });
    await tick(15 * MIN);
    await expect(syncConnection(h.ctx, a.id, "google")).rejects.toThrow();
    const after = await connectionRow(a);
    expect(after?.busy_snapshot).toBe(before?.busy_snapshot);
    // 権利を戻したので、すぐにやり直せる
    h.google.state.freeBusyOverride = null;
    h.google.state.busy = [busy(T("01:00", "20"), T("02:00", "20")), busy(T("11:00", "11"), T("12:00", "11"))];
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("synced");
    expect(await outbox("AvailabilityCancelledByCalendar", a.id)).toHaveLength(1);
  });

  it("取り消しが20を超えた1回目は保留にし、次の確認でも同じなら取り消す", async () => {
    const a = await authenticated();
    for (let d = 11; d <= 31; d++) {
      const date = `2026-10-${String(d).padStart(2, "0")}`;
      expect((await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date, preset: "night" } })).status).toBe(201);
    }
    await synced(a);
    await tick(15 * MIN);
    h.google.state.busy = [busy(T("00:00", "11"), "2026-11-01T00:00:00.000Z")];
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("held");
    expect((await connectionRow(a))?.large_change_held).toBe(1);
    expect(await myItems(a)).toHaveLength(21);
    expect(await outbox("AvailabilityCancelledByCalendar", a.id)).toHaveLength(0);
    await tick(15 * MIN);
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("synced");
    expect(await myItems(a)).toHaveLength(0);
    expect((await connectionRow(a))?.large_change_held).toBe(0);
  });

  it("保留の次の確認で20以下に戻れば、ふつうに処理して保留を外す", async () => {
    const a = await authenticated();
    for (let d = 11; d <= 31; d++) {
      const date = `2026-10-${String(d).padStart(2, "0")}`;
      await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date, preset: "night" } });
    }
    await synced(a);
    await tick(15 * MIN);
    h.google.state.busy = [busy(T("00:00", "11"), "2026-11-01T00:00:00.000Z")];
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("held");
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11"))];
    await tick(15 * MIN);
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("synced");
    expect(await myItems(a)).toHaveLength(20);
    expect((await connectionRow(a))?.large_change_held).toBe(0);
  });

  it("権利が取れないときは何もしない。確認の途中で解除されたら batch のどの文も書かない", async () => {
    const a = await authenticated();
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await synced(a);
    await env.DB.prepare("UPDATE calendar_connections SET sync_lease_until = ?2 WHERE user_id = ?1")
      .bind(a.id, h.clock.now + MIN)
      .run();
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("skipped");
    await env.DB.prepare("UPDATE calendar_connections SET sync_lease_until = NULL WHERE user_id = ?1").bind(a.id).run();

    await tick(15 * MIN);
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11"))];
    // freeBusy の応答の間に解除される
    h.google.state.freeBusyOverride = () => {
      void env.DB.prepare("UPDATE calendar_connections SET status = 'disconnected', sync_lease_until = NULL WHERE user_id = ?1")
        .bind(a.id)
        .run();
      return Response.json({ calendars: { primary: { busy: h.google.state.busy } } });
    };
    await syncConnection(h.ctx, a.id, "google");
    expect(await myItems(a)).toHaveLength(1);
    expect(await outbox("AvailabilityCancelledByCalendar", a.id)).toHaveLength(0);
  });

  it("友達から見える応答は、手で取り消したときと同じ（ここ暇が消えるだけ）", async () => {
    const a = await authenticated();
    const b = await authenticated("べに");
    await u.befriend(a, b);
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await synced(a);
    await tick(15 * MIN);
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11"))];
    await syncConnection(h.ctx, a.id, "google");
    const auto = await u.call("GET", `/api/v1/friends/${a.id}/availabilities?from=${T("00:00")}&to=${T("00:00", "30")}`, {
      token: b.token,
    });
    expect(await auto.json()).toEqual({ items: [], nextCursor: null });
  });

  it("Cron（15分ごと）は確認する連携を Queue に送る（10分以上前・古い順）", async () => {
    const a = await authenticated();
    await connect(a);
    await runScheduled("*/15 * * * *", h.bindings, h.deps);
    expect(h.jobs).toContainEqual({ kind: "calendar_sync", userId: a.id, provider: "google" });
    await syncConnection(h.ctx, a.id, "google");
    h.jobs.length = 0;
    await tick(5 * MIN);
    await runScheduled("*/15 * * * *", h.bindings, h.deps);
    expect(h.jobs.some((j) => j.kind === "calendar_sync" && j.userId === a.id)).toBe(false);
  });
});

describe("自動の「今回は難しい」", () => {
  async function scenario() {
    const a = await authenticated();
    const b = await authenticated("べに");
    await u.befriend(a, b);
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await tick(MIN);
    await connect(a);
    await syncConnection(h.ctx, a.id, "google");
    return { a, b };
  }
  const invite = async (from: User, to: User, startsAt: string, endsAt: string) => {
    const res = await u.call("POST", "/api/v1/direct-invites", { token: from.token, body: { recipientId: to.id, startsAt, endsAt } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const inviteStatus = async (who: User, id: string) =>
    ((await (await u.call("GET", `/api/v1/direct-invites/${id}`, { token: who.token })).json()) as { status: string }).status;

  it("取り消した枠と重なる pending だけが declined になり、送信者には手で断ったときと同じに見える", async () => {
    const { a, b } = await scenario();
    const c = await authenticated("ちさ");
    await u.befriend(c, a);
    await u.befriend(b, c);
    const hit = await invite(b, a, T("11:00", "11"), T("12:00", "11"));
    const away = await invite(b, a, T("02:00", "11"), T("03:00", "11"));
    const toC = await invite(b, c, T("11:00", "11"), T("12:00", "11"));
    const manual = await invite(c, a, T("12:00", "11"), T("13:00", "11"));
    await u.call("POST", `/api/v1/direct-invites/${manual}/responses`, { token: a.token, body: { response: "decline" } });
    const counter = await invite(b, a, T("12:30", "11"), T("13:30", "11"));
    await u.call("POST", `/api/v1/direct-invites/${counter}/responses`, {
      token: a.token,
      body: { response: "counter", startsAt: T("03:00", "12"), endsAt: T("04:00", "12") },
    });

    await tick(15 * MIN);
    h.google.state.busy = [busy(T("13:00", "11"), T("14:00", "11"))];
    await syncConnection(h.ctx, a.id, "google");
    await deliver("AvailabilityCancelledByCalendar", a.id);

    expect(await inviteStatus(b, hit)).toBe("declined");
    expect(await inviteStatus(b, away)).toBe("pending");
    expect(await inviteStatus(b, toC)).toBe("pending");
    expect(await inviteStatus(b, counter)).toBe("counter_proposed");
    const declined = await outbox("DirectInviteDeclined", hit);
    expect(declined).toHaveLength(1);
    expect(declined[0]).toMatchObject({ userId: b.id, inviteId: hit, actorId: a.id });
    // 送信者から見た形は手で断ったときと同じ（項目の並びと値）
    const autoView = (await (await u.call("GET", `/api/v1/direct-invites/${hit}`, { token: b.token })).json()) as Record<string, unknown>;
    const manualView = (await (await u.call("GET", `/api/v1/direct-invites/${manual}`, { token: c.token })).json()) as Record<string, unknown>;
    expect(Object.keys(autoView)).toEqual(Object.keys(manualView));
    expect(autoView.status).toBe(manualView.status);

    // 2回届いても1回だけ
    await deliver("AvailabilityCancelledByCalendar", a.id);
    expect(await outbox("DirectInviteDeclined", hit)).toHaveLength(1);
  });

  it("取り消しの後に作られた誘い・期限切れの誘いは変わらない", async () => {
    const { a, b } = await scenario();
    const expiring = await invite(b, a, T("11:00", "11"), T("12:00", "11"));
    await env.DB.prepare("UPDATE direct_invites SET expires_at = ?2 WHERE id = ?1").bind(expiring, h.clock.now + 20 * MIN).run();
    await tick(15 * MIN);
    h.google.state.busy = [busy(T("13:00", "11"), T("14:00", "11"))];
    await syncConnection(h.ctx, a.id, "google");
    await tick(MIN);
    await u.advance(0, a, b);
    const after = await invite(b, a, T("11:30", "11"), T("12:30", "11"));
    await tick(10 * MIN);
    await u.advance(0, a, b);
    await deliver("AvailabilityCancelledByCalendar", a.id);
    expect(await inviteStatus(b, after)).toBe("pending");
    expect(await inviteStatus(b, expiring)).toBe("expired");
  });
});

describe("成立した予定の書き込み", () => {
  /** a と b の成立した予定（誘いの「行く」） */
  async function meetupOf(a: User, b: User, startsAt = T("11:00", "11"), endsAt = T("13:00", "11")) {
    await u.befriend(a, b);
    const res = await u.call("POST", "/api/v1/direct-invites", {
      token: a.token,
      body: { recipientId: b.id, startsAt, endsAt, area: "渋谷", message: "ひみつのひとこと" },
    });
    const id = ((await res.json()) as { id: string }).id;
    const accepted = await u.call("POST", `/api/v1/direct-invites/${id}/responses`, { token: b.token, body: { response: "accept" } });
    return ((await accepted.json()) as { meetupId: string }).meetupId;
  }

  it("連携している参加者だけに書く。タイトル・場所・説明、ひとことは書かない。2回届いても同じ", async () => {
    const a = await authenticated();
    const b = await authenticated("べに");
    await connect(a);
    const meetupId = await meetupOf(a, b);
    await deliver("MeetupConfirmed", meetupId);
    await deliver("MeetupConfirmed", meetupId);
    const events = h.google.liveEvents();
    expect(events).toHaveLength(1);
    const body = events[0]?.body as Record<string, unknown>;
    expect(body.id).toBe(`kh${meetupId.replace(/-/g, "")}`);
    expect(body.summary).toBe("ここ暇：べに");
    expect(body.location).toBe("渋谷");
    expect(body.description).toBe(`https://app.test/meetups/${meetupId}`);
    expect(JSON.stringify(body)).not.toContain("ひみつ");
    expect([...h.google.state.calendars.values()]).toEqual([{ summary: "ここ暇", timeZone: "Asia/Tokyo" }]);
  });

  it("キャンセルで消す。解除した人には何もしない", async () => {
    const a = await authenticated();
    const b = await authenticated("べに");
    await connect(a);
    await connect(b);
    const meetupId = await meetupOf(a, b);
    await deliver("MeetupConfirmed", meetupId);
    expect(h.google.liveEvents()).toHaveLength(2);
    await u.call("DELETE", "/api/v1/calendar/connections/google", { token: b.token });
    await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: a.token });
    await deliver("MeetupCancelled", meetupId);
    // a の分は消え、解除した b の分は残る（解除後はこちらから消さない）
    expect(h.google.liveEvents()).toHaveLength(1);
  });

  it("確定とキャンセルが入れ違っても、書いた後の読み直しで消す", async () => {
    const a = await authenticated();
    const b = await authenticated("べに");
    await connect(a);
    const meetupId = await meetupOf(a, b);
    await deliver("MeetupConfirmed", meetupId); // カレンダーを作る
    h.google.state.events.clear();
    // 予定の書き込みの応答の間にキャンセルされる
    const original = h.google.handle;
    let cancelled = false;
    vi.spyOn(h.google, "handle").mockImplementation(async (url, init) => {
      const res = await original(url, init);
      if (!cancelled && (init?.method ?? "GET") === "POST" && url.pathname.endsWith("/events")) {
        cancelled = true;
        await env.DB.prepare("UPDATE meetups SET status = 'cancelled' WHERE id = ?1").bind(meetupId).run();
      }
      return res;
    });
    await deliver("MeetupConfirmed", meetupId);
    expect(h.google.liveEvents()).toHaveLength(0);
  });

  it("カレンダーがなければ作り、同時に作ったら片方を消す。404 なら作り直して書き直す", async () => {
    const a = await authenticated();
    const b = await authenticated("べに");
    await connect(a);
    const meetupId = await meetupOf(a, b);
    await Promise.all([deliver("MeetupConfirmed", meetupId), deliver("MeetupConfirmed", meetupId)]);
    expect(h.google.state.calendars.size).toBe(1);
    const calendarId = (await connectionRow(a))?.calendar_id;
    expect(calendarId && h.google.state.calendars.has(calendarId)).toBe(true);

    // 利用者がカレンダーを消した
    h.google.state.calendars.clear();
    h.jobs.length = 0;
    await deliver("MeetupConfirmed", meetupId);
    expect((await connectionRow(a))?.calendar_id).toBeNull();
    const rewrite = h.jobs.find((j) => j.kind === "outbox" && j.type === "CalendarConnected");
    expect(rewrite).toBeDefined();
    if (rewrite) await handleJob(h.ctx, rewrite);
    expect(h.google.liveEvents().filter((e) => e.calendarId !== calendarId)).toHaveLength(1);
  });

  it("募集の予定で抜けた人の予定を消し、残りの人のタイトルを直す", async () => {
    const owner = await authenticated("あき");
    const f1 = await authenticated("べに");
    const f2 = await authenticated("ちさ");
    await u.befriend(owner, f1);
    await u.befriend(owner, f2);
    for (const who of [owner, f1, f2]) await connect(who);
    const created = await u.call("POST", "/api/v1/broadcasts", {
      token: owner.token,
      body: { recipientIds: [f1.id, f2.id], startsAt: T("11:00", "11"), endsAt: T("13:00", "11") },
    });
    const broadcastId = ((await created.json()) as { id: string }).id;
    await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f1.token });
    await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f2.token });
    const decided = await u.call("POST", `/api/v1/broadcasts/${broadcastId}/decide`, { token: owner.token });
    const meetupId = ((await decided.json()) as { meetupId: string }).meetupId;
    await deliver("MeetupConfirmed", meetupId);
    expect(h.google.liveEvents()).toHaveLength(3);
    await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: f2.token });
    await deliver("MeetupLeft", meetupId);
    const live = h.google.liveEvents();
    expect(live).toHaveLength(2);
    expect(live.map((e) => (e.body as { summary: string }).summary).sort()).toEqual(["ここ暇：あき", "ここ暇：べに"]);
  });

  it("CalendarConnected で、これからの予定を書き、解除中にキャンセルされた予定を消す", async () => {
    const a = await authenticated();
    const b = await authenticated("べに");
    await connect(a);
    const keep = await meetupOf(a, b);
    await deliver("MeetupConfirmed", keep);
    const c = await authenticated("ちさ");
    const gone = await meetupOf(a, c, T("11:00", "12"), T("13:00", "12"));
    await deliver("MeetupConfirmed", gone);
    expect(h.google.liveEvents()).toHaveLength(2);
    await u.call("DELETE", "/api/v1/calendar/connections/google", { token: a.token });
    await u.call("POST", `/api/v1/meetups/${gone}/cancel`, { token: a.token });
    await deliver("MeetupCancelled", gone);
    expect(h.google.liveEvents()).toHaveLength(2);
    await connect(a);
    await deliver("CalendarConnected", a.id);
    const live = h.google.liveEvents();
    expect(live).toHaveLength(1);
    expect((live[0]?.body as { id: string }).id).toBe(`kh${keep.replace(/-/g, "")}`);
  });
});

describe("outbox を Queue に流す", () => {
  it("処理する型だけを送り、送ってから処理済みにする。ほかの型は未処理のまま", async () => {
    const a = await authenticated();
    await connect(a);
    h.jobs.length = 0;
    await dispatchOutbox(h.ctx);
    expect(h.jobs.some((j) => j.kind === "outbox" && j.type === "CalendarConnected" && j.payload.includes(a.id))).toBe(true);
    expect(h.jobs.some((j) => j.kind === "outbox" && j.type === "SessionStarted")).toBe(false);
    expect((await outbox("CalendarConnected", a.id))[0]?.processedAt).toBe(h.clock.now);
    const other = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox WHERE type NOT IN ('MeetupConfirmed','MeetupCancelled','MeetupLeft','CalendarConnected','AvailabilityCancelledByCalendar') AND processed_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(other?.n).toBe(0);
  });

  it("送れなければ未処理のまま残り、次の実行で送り直す", async () => {
    const a = await authenticated();
    await connect(a);
    const failing = {
      ...h.bindings,
      JOBS: {
        sendBatch: async () => {
          throw new Error("queue down");
        },
      } as unknown as Queue<never>,
    };
    await expect(dispatchOutbox({ env: failing, deps: h.deps })).rejects.toThrow();
    expect((await outbox("CalendarConnected", a.id))[0]?.processedAt).toBeNull();
    // 1回に最大100件。何回か流せば、この人の行も送られる
    for (let n = 0; n < 20 && (await outbox("CalendarConnected", a.id))[0]?.processedAt === null; n++) {
      await dispatchOutbox(h.ctx);
    }
    expect((await outbox("CalendarConnected", a.id))[0]?.processedAt).not.toBeNull();
  });

  it("期限切れの state と .ics のトークンを掃除する", async () => {
    const a = await authenticated();
    await authorize(a);
    h.clock.now += 11 * MIN;
    await runScheduled("* * * * *", h.bindings, h.deps);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_oauth_states WHERE user_id = ?1").bind(a.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("知らない型は何もせずに受け取る", async () => {
    await expect(handleJob(h.ctx, { kind: "outbox", id: "x", type: "FriendshipEstablished", payload: "{}" })).resolves.toBeUndefined();
  });
});

describe(".ics", () => {
  async function meetup() {
    const a = await authenticated();
    const b = await authenticated("べに");
    await u.befriend(a, b);
    const res = await u.call("POST", "/api/v1/direct-invites", {
      token: a.token,
      body: { recipientId: b.id, startsAt: T("11:00", "11"), endsAt: T("13:00", "11"), area: "渋谷;駅,前" },
    });
    const id = ((await res.json()) as { id: string }).id;
    const accepted = await u.call("POST", `/api/v1/direct-invites/${id}/responses`, { token: b.token, body: { response: "accept" } });
    return { a, b, meetupId: ((await accepted.json()) as { meetupId: string }).meetupId };
  }
  const link = (who: User, id: string) => u.call("POST", `/api/v1/meetups/${id}/ics-links`, { token: who.token });

  it("参加者はリンクを発行して取得できる。中身とヘッダー", async () => {
    const { a, meetupId } = await meetup();
    const res = await link(a, meetupId);
    expect(res.status).toBe(200);
    const body = icsLinkSchema.parse(await res.json());
    expect(body.expiresAt).toBe(new Date(h.clock.now + 5 * MIN).toISOString());
    const path = new URL(body.url).pathname;
    expect(path).toMatch(/^\/api\/v1\/ics\/[A-Za-z0-9_-]{43}$/);
    const ics = await h.request(path);
    expect(ics.status).toBe(200);
    expect(ics.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(ics.headers.get("Content-Disposition")).toBe(`attachment; filename="kokohima-${meetupId}.ics"`);
    expect(ics.headers.get("Cache-Control")).toBe("no-store");
    expect(ics.headers.get("Referrer-Policy")).toBe("no-referrer");
    const text = await ics.text();
    expect(text).toContain(`UID:${meetupId}@kokohima`);
    expect(text).toContain("DTSTART:20261011T110000Z");
    expect(text).toContain("SUMMARY:ここ暇：べに");
    expect(text).toContain("LOCATION:渋谷\\;駅\\,前");
    expect(text).toContain("STATUS:CONFIRMED");
    // 期限内なら2回読める
    expect((await h.request(path)).status).toBe(200);
    // トークンはハッシュだけを保存する
    const token = path.split("/").at(-1) ?? "";
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM ics_tokens WHERE token_hash = ?1").bind(token).first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("キャンセル済みは STATUS:CANCELLED", async () => {
    const { a, meetupId } = await meetup();
    await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: a.token });
    const path = new URL(icsLinkSchema.parse(await (await link(a, meetupId)).json()).url).pathname;
    const text = await (await h.request(path)).text();
    expect(text).toContain("STATUS:CANCELLED");
    expect(text).toContain("SEQUENCE:1");
  });

  it("参加者でない・存在しない・期限切れ・壊れたトークンは同じ404", async () => {
    const { a, meetupId } = await meetup();
    const stranger = await authenticated("よそ");
    const notFound = async (res: Response) => {
      expect(res.status).toBe(404);
      const json = (await res.json()) as Record<string, unknown>;
      return JSON.stringify({ ...json, requestId: null });
    };
    const bodies = [
      await notFound(await link(stranger, meetupId)),
      await notFound(await link(a, crypto.randomUUID())),
      await notFound(await link(a, "not-a-uuid")),
    ];
    const path = new URL(icsLinkSchema.parse(await (await link(a, meetupId)).json()).url).pathname;
    h.clock.now += 5 * MIN;
    bodies.push(await notFound(await h.request(path)));
    bodies.push(await notFound(await h.request("/api/v1/ics/short")));
    expect(new Set(bodies).size).toBe(1);
    expect((await u.call("POST", `/api/v1/meetups/${meetupId}/ics-links`)).status).toBe(401);
  });

  it("募集の予定から抜けた人はリンクを発行できず、発行後に抜けたら取得できない", async () => {
    const owner = await authenticated("あき");
    const f1 = await authenticated("べに");
    const f2 = await authenticated("ちさ");
    await u.befriend(owner, f1);
    await u.befriend(owner, f2);
    const created = await u.call("POST", "/api/v1/broadcasts", {
      token: owner.token,
      body: { recipientIds: [f1.id, f2.id], startsAt: T("11:00", "11"), endsAt: T("13:00", "11") },
    });
    const broadcastId = ((await created.json()) as { id: string }).id;
    await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f1.token });
    await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f2.token });
    const decided = await u.call("POST", `/api/v1/broadcasts/${broadcastId}/decide`, { token: owner.token });
    const meetupId = ((await decided.json()) as { meetupId: string }).meetupId;
    const path = new URL(icsLinkSchema.parse(await (await link(f2, meetupId)).json()).url).pathname;
    await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: f2.token });
    expect((await h.request(path)).status).toBe(404);
    expect((await link(f2, meetupId)).status).toBe(404);
    expect((await link(f1, meetupId)).status).toBe(200);
  });
});

describe("Google へのリクエスト", () => {
  it("呼ぶのは許可した経路だけ（予定の一覧・取得、カレンダーの一覧を呼ばない）", async () => {
    const a = await authenticated();
    const b = await authenticated("べに");
    await connect(a);
    await u.befriend(a, b);
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await u.call("GET", `/api/v1/calendar/free-slots?from=${T("00:00")}&to=${T("00:00", "12")}`, { token: a.token });
    await syncConnection(h.ctx, a.id, "google");
    const res = await u.call("POST", "/api/v1/direct-invites", {
      token: b.token,
      body: { recipientId: a.id, startsAt: T("02:00", "12"), endsAt: T("03:00", "12") },
    });
    const id = ((await res.json()) as { id: string }).id;
    const accepted = await u.call("POST", `/api/v1/direct-invites/${id}/responses`, { token: a.token, body: { response: "accept" } });
    const meetupId = ((await accepted.json()) as { meetupId: string }).meetupId;
    await deliver("MeetupConfirmed", meetupId);
    await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: a.token });
    await deliver("MeetupCancelled", meetupId);
    await u.call("DELETE", "/api/v1/calendar/connections/google", { token: a.token });

    const allowed = [
      /^POST oauth2\.googleapis\.com\/token$/,
      /^POST oauth2\.googleapis\.com\/revoke$/,
      /^POST www\.googleapis\.com\/calendar\/v3\/freeBusy$/,
      /^POST www\.googleapis\.com\/calendar\/v3\/calendars$/,
      /^DELETE www\.googleapis\.com\/calendar\/v3\/calendars\/[^/]+$/,
      /^(POST) www\.googleapis\.com\/calendar\/v3\/calendars\/[^/]+\/events$/,
      /^(PUT|DELETE) www\.googleapis\.com\/calendar\/v3\/calendars\/[^/]+\/events\/kh[0-9a-v]+$/,
    ];
    const seen = h.google.state.requests.map((r) => `${r.method} ${new URL(r.url).host}${r.path}`);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(allowed.some((re) => re.test(s)), s).toBe(true);
    for (const r of h.google.state.requests.filter((r) => r.path.endsWith("/freeBusy"))) {
      expect((JSON.parse(r.body) as { items: unknown }).items).toEqual([{ id: "primary" }]);
    }
  });
});
