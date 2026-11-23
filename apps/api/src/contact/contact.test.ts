import { env } from "cloudflare:workers";
import { CONTACT_BODY_MAX } from "@kokohima/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, ORIGIN } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { defaultDeps } from "../app";
import type { Bindings, JobMessage } from "../env";
import { activeUserExistsSql, getContactSender } from "../identity/application/auth";
import { handleBatch, handleJob, MAX_RETRIES } from "../jobs/consumer";
import { dispatchOutbox, toJobMessage } from "../jobs/dispatch";
import { submitContactMessage } from "./application/submit";
import { CONTACT_WEBHOOK_TARGET } from "./domain/webhook";
import { redact } from "./infra/repository";
import repositorySource from "./infra/repository.ts?raw";
import indexSource from "../index.ts?raw";

// 問い合わせ（docs/specs/T-24-contact.md「テスト計画」）。時計は 2026-10-10T00:00:00Z。公開の日は、ほかのテストでは 0 にする
// テストの間で DB は共有されるので、関係する ID だけを読む

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;
let output: string[];

beforeEach(async () => {
  h = await createHarness({ contactStartAt: 0 });
  u = makeUsers(h);
  output = [];
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** ログや例外に出ていないかを確かめる、見分けやすい内容とアドレス */
const MARK = "見分け用の内容-Zq81";
const PATH = "/api/v1/contact-messages";

const send = (who: User, body: unknown, opts: { origin?: string | null; headers?: Record<string, string> } = {}) =>
  u.call("POST", PATH, { token: who.token, body, ...opts });

const rowsOf = async (userId: string) =>
  (
    await env.DB.prepare(
      "SELECT id, payload, created_at, processed_at FROM outbox WHERE type = 'ContactMessageSubmitted' AND json_extract(payload, '$.userId') = ? ORDER BY created_at, id",
    )
      .bind(userId)
      .all<{ id: string; payload: string; created_at: number; processed_at: number | null }>()
  ).results;

/** メールアドレスを登録した利用者 */
async function userWithEmail(email: string): Promise<User> {
  const r = await h.login("google", `sub-${crypto.randomUUID()}`, { email, email_verified: true });
  const me = (await (await u.call("GET", "/api/v1/me", { token: r.accessToken })).json()) as { id: string };
  return { id: me.id, token: r.accessToken, refreshToken: r.refreshToken, name: email };
}

const withdraw = (who: User) =>
  u.call("POST", "/api/v1/me/withdrawal", { token: who.token, body: { confirm: "withdraw" }, cookie: `__Host-kh_rt=${who.refreshToken}` });

const deliverRow = (row: { id: string; created_at: number }, payload = "{}") =>
  handleJob(h.ctx, { kind: "outbox", id: row.id, type: "ContactMessageSubmitted", payload, createdAt: row.created_at });

/** 送った JSON の中の、すべての文字列（plain_text の欄を含む） */
type Block = { type: string; text?: { type: string; text: string; emoji?: boolean }; fields?: { type: string; text: string; emoji?: boolean }[] };
type SlackJson = { text: string; unfurl_links: boolean; unfurl_media: boolean; blocks: Block[] };

describe("受け付け（POST /contact-messages）", () => {
  it("ログインした人が送ると204で、outbox に1行。payload は userId・category・body（正規化のあと）・occurredAt だけ", async () => {
    const a = await userWithEmail("a-contact@example.com");
    output = [];
    const res = await send(a, { category: "bug", body: "  動きません\r\n手順：1" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const rows = await rowsOf(a.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? "")).toEqual({
      userId: a.id,
      category: "bug",
      body: "動きません\n手順：1",
      occurredAt: new Date(h.clock.now).toISOString(),
    });
    expect(rows[0]?.payload).not.toContain("a-contact@example.com");
    // 受け付けのログは出さない
    expect(output).toEqual([]);
  });

  it("入力検証：知らない項目・一覧にない種類・本文がない・数値・JSON でないは400で、行ができない", async () => {
    const a = await u.user();
    for (const body of [
      { category: "bug", body: "a", userId: a.id },
      { category: "bug", body: "a", email: "x@example.com" },
      { category: "spam", body: "a" },
      { category: "bug" },
      { category: "bug", body: 1 },
      { category: "bug", body: " " },
      { category: "bug", body: "a‮b" },
    ]) {
      const res = await send(a, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    }
    expect((await u.call("POST", PATH, { token: a.token, headers: { "Content-Type": "application/json" } })).status).toBe(400);
    expect(await rowsOf(a.id)).toHaveLength(0);
  });

  describe("本文の上限（8192バイト）", () => {
    /** ちょうど n バイトの JSON（内容は長すぎて検証で落ちる） */
    const jsonOf = (n: number) => {
      const head = '{"category":"bug","body":"';
      const tail = '"}';
      return `${head}${"a".repeat(n - head.length - tail.length)}${tail}`;
    };
    const raw = (who: User, body: BodyInit, headers: Record<string, string> = {}) =>
      h.request(PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${who.token}`, Origin: ORIGIN, "Content-Type": "application/json", ...headers },
        body,
      });
    const errorsOf = async (res: Response) => ((await res.json()) as { errors: { path: string }[] }).errors;

    it("ちょうど8192バイトは検証まで進み、8193バイトは読む前に400", async () => {
      const a = await u.user();
      expect(new TextEncoder().encode(jsonOf(8192)).length).toBe(8192);
      const ok = await raw(a, jsonOf(8192));
      expect(ok.status).toBe(400);
      expect((await errorsOf(ok)).map((e) => e.path)).toEqual(["body"]);
      const over = await raw(a, jsonOf(8193));
      expect(over.status).toBe(400);
      expect(await errorsOf(over)).toEqual([]);
    });

    it("Content-Length がなくても、読み込んだ長さで400", async () => {
      const a = await u.user();
      const bytes = new TextEncoder().encode(jsonOf(8193));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4000));
          controller.enqueue(bytes.slice(4000));
          controller.close();
        },
      });
      const res = await raw(a, stream);
      expect(res.status).toBe(400);
      expect(await errorsOf(res)).toEqual([]);
    });

    it("Content-Length が上限を超える・数でないと400", async () => {
      const a = await u.user();
      expect((await raw(a, jsonOf(100), { "Content-Length": "9000" })).status).toBe(400);
      expect((await raw(a, jsonOf(100), { "Content-Length": "abc" })).status).toBe(400);
    });

    it("8193バイトに Idempotency-Key を付けても400で、idempotency_keys に行ができない（上限が idempotent より前）", async () => {
      const a = await u.user();
      const res = await raw(a, jsonOf(8193), { "Idempotency-Key": crypto.randomUUID() });
      expect(res.status).toBe(400);
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE user_id = ?").bind(a.id).first<{ n: number }>();
      expect(n?.n).toBe(0);
    });
  });

  it("認証：トークンがない・不正なら401。Origin が違う・ないと401。どれも行ができない", async () => {
    const a = await u.user();
    const body = { category: "bug", body: "a" };
    expect((await u.call("POST", PATH, { body })).status).toBe(401);
    expect((await u.call("POST", PATH, { body, token: "broken.token.value" })).status).toBe(401);
    expect((await send(a, body, { origin: "https://evil.example" })).status).toBe(401);
    expect((await send(a, body, { origin: null })).status).toBe(401);
    expect(await rowsOf(a.id)).toHaveLength(0);
  });

  it("退会した利用者のアクセストークン（期限内）は401で、行ができない", async () => {
    const a = await u.user();
    expect((await withdraw(a)).status).toBe(204);
    expect((await send(a, { category: "bug", body: "a" })).status).toBe(401);
    expect(await rowsOf(a.id)).toHaveLength(0);
  });

  it("受け付けの文の直前に退会していたら401（上限に達していても429 にならない）", async () => {
    const a = await u.user();
    for (let i = 0; i < 3; i++) expect((await send(a, { category: "other", body: `${i}` })).status).toBe(204);
    await env.DB.prepare("UPDATE users SET withdrawn_at = ? WHERE id = ?").bind(h.clock.now, a.id).run();
    expect(await submitContactMessage(h.ctx, a.id, { category: "bug", body: "x" })).toEqual({ kind: "unauthenticated" });
    const b = await u.user();
    await env.DB.prepare("UPDATE users SET withdrawn_at = ? WHERE id = ?").bind(h.clock.now, b.id).run();
    expect(await submitContactMessage(h.ctx, b.id, { category: "bug", body: "x" })).toEqual({ kind: "unauthenticated" });
    expect(await rowsOf(b.id)).toHaveLength(0);
  });

  it("送り主を偽れない：本文に B の userId を入れると400。正しく送ると行の userId は A で、Slack には A のアドレスだけが出る", async () => {
    const a = await userWithEmail("a-sender@example.com");
    const b = await userWithEmail("b-other@example.com");
    expect((await send(a, { category: "bug", body: "x", userId: b.id })).status).toBe(400);
    expect((await send(a, { category: "privacy_request", body: `B の ID は ${b.id}` })).status).toBe(204);
    expect(await rowsOf(b.id)).toHaveLength(0);
    const [row] = await rowsOf(a.id);
    if (!row) throw new Error("no row");
    await deliverRow(row);
    const post = h.slack.state.posts.at(-1);
    expect(post?.body).toContain("返信先：a-sender@example.com");
    expect(post?.body).toContain(`利用者ID：${a.id}`);
    expect(post?.body).not.toContain("b-other@example.com");
  });

  describe("回数の上限（直近24時間に3件）", () => {
    it("4件目は429 で、Retry-After は最も古い行が24時間を過ぎるまでの秒数。ログは rate_limited と group だけ", async () => {
      const a = await u.user();
      for (let i = 0; i < 3; i++) {
        expect((await send(a, { category: "feedback", body: `${i}` })).status).toBe(204);
        await u.advance(HOUR, a);
      }
      output = [];
      const res = await send(a, { category: "feedback", body: "4" });
      expect(res.status).toBe(429);
      expect(((await res.json()) as { code: string }).code).toBe("rate_limited");
      expect(res.headers.get("Retry-After")).toBe(String(21 * 60 * 60));
      expect(output).toEqual([JSON.stringify({ event: "rate_limited", group: "contact_messages" })]);
      expect(await rowsOf(a.id)).toHaveLength(3);
    });

    it("ちょうど24時間前の行は数えない（境目に now を置いても、429 と401 を取り違えない）", async () => {
      const a = await u.user();
      const start = h.clock.now;
      for (let i = 0; i < 3; i++) {
        expect(await submitContactMessage(h.ctx, a.id, { category: "bug", body: `${i}` })).toEqual({ kind: "ok" });
        h.clock.now += 1;
      }
      h.clock.now = start + DAY - 1;
      expect(await submitContactMessage(h.ctx, a.id, { category: "bug", body: "x" })).toEqual({ kind: "rate_limited", retryAfterSeconds: 1 });
      h.clock.now = start + DAY;
      expect(await submitContactMessage(h.ctx, a.id, { category: "bug", body: "y" })).toEqual({ kind: "ok" });
      expect(await submitContactMessage(h.ctx, a.id, { category: "bug", body: "z" })).toEqual({ kind: "rate_limited", retryAfterSeconds: 1 });
    });

    it("B の送った数は A の上限に影響しない", async () => {
      const a = await u.user();
      const b = await u.user();
      for (let i = 0; i < 3; i++) expect((await send(b, { category: "bug", body: `${i}` })).status).toBe(204);
      expect((await send(b, { category: "bug", body: "4" })).status).toBe(429);
      expect((await send(a, { category: "bug", body: "1" })).status).toBe(204);
    });

    it("同時に4件送っても3件しか入らない（上限の判定と書き込みが1つの文）", async () => {
      const a = await u.user();
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => send(a, { category: "bug", body: `${i}` })));
      expect(results.map((r) => r.status).sort()).toEqual([204, 204, 204, 429]);
      expect(await rowsOf(a.id)).toHaveLength(3);
    });
  });

  it("冪等：同じキー・同じ本文の再送は204で行は1つ。違う本文は422。idempotency_keys に内容が入らない", async () => {
    const a = await u.user();
    const key = crypto.randomUUID();
    const body = { category: "bug", body: MARK };
    const first = await send(a, body, { headers: { "Idempotency-Key": key } });
    expect(first.status).toBe(204);
    const again = await send(a, body, { headers: { "Idempotency-Key": key } });
    expect(again.status).toBe(204);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await rowsOf(a.id)).toHaveLength(1);
    expect((await send(a, { category: "bug", body: "違う" }, { headers: { "Idempotency-Key": key } })).status).toBe(422);
    const stored = await env.DB.prepare("SELECT * FROM idempotency_keys WHERE user_id = ?").bind(a.id).all();
    expect(stored.results).toHaveLength(1);
    expect(JSON.stringify(stored.results)).not.toContain(MARK);
  });

  it("contact の infra は users を直接読まず、identity の activeUserExistsSql を使う", () => {
    expect(repositorySource).toContain("activeUserExistsSql");
    expect(repositorySource).not.toMatch(/\bFROM users\b|\bUPDATE users\b|\bINTO users\b/);
    expect(activeUserExistsSql("?5")).toBe("EXISTS (SELECT 1 FROM users WHERE id = ?5 AND withdrawn_at IS NULL)");
    expect(() => activeUserExistsSql("1 OR 1=1")).toThrow();
  });

  it("getContactSender：退会していないかと返信先。行がなければ退会と同じ", async () => {
    const a = await userWithEmail("sender-check@example.com");
    expect(await getContactSender(h.bindings, a.id)).toEqual({ active: true, email: "sender-check@example.com" });
    expect(await getContactSender(h.bindings, crypto.randomUUID())).toEqual({ active: false, email: null });
    expect((await withdraw(a)).status).toBe(204);
    expect(await getContactSender(h.bindings, a.id)).toEqual({ active: false, email: null });
  });
});

describe("公開の日（振る舞い 11.）", () => {
  it("公開の日より前は、正しいトークンと本文でも、トークンなしでも、知らない経路と同じ404 で行ができない", async () => {
    const closed = await createHarness();
    const cu = makeUsers(closed);
    const a = await cu.user();
    const unknown = await cu.call("POST", "/api/v1/no-such-route", { token: a.token, body: {} });
    const unknownBody = (await unknown.json()) as Record<string, unknown>;
    for (const token of [a.token, undefined]) {
      const res = await cu.call("POST", PATH, { token, body: { category: "bug", body: "a" } });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect({ ...body, requestId: "" }).toEqual({ ...unknownBody, requestId: "" });
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
    }
    expect(await rowsOf(a.id)).toHaveLength(0);
  });

  it("ちょうど公開の日（日本時間の0時）から受け付ける。null ならいつも404", async () => {
    const start = Date.parse("2026-10-10T00:00:00Z");
    const open = await createHarness({ contactStartAt: start + 1 });
    const ou = makeUsers(open);
    const a = await ou.user();
    expect((await ou.call("POST", PATH, { token: a.token, body: { category: "bug", body: "a" } })).status).toBe(404);
    open.clock.now = start + 1;
    expect((await ou.call("POST", PATH, { token: a.token, body: { category: "bug", body: "a" } })).status).toBe(204);
    const never = await createHarness({ contactStartAt: null });
    const nu = makeUsers(never);
    const b = await nu.user();
    never.clock.now = Date.parse("2100-01-01T00:00:00Z");
    expect((await nu.call("POST", PATH, { token: b.token, body: { category: "bug", body: "a" } })).status).toBe(404);
  });

  it("既定の公開の日は packages/shared の contactStartAt()（contactStart.json）", async () => {
    const { contactStartAt } = await import("@kokohima/shared");
    expect(defaultDeps().contactStartAt).toBe(contactStartAt());
  });
});

describe("outbox から Queues へ（振る舞い 2.）", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM outbox").run();
  });

  it("この型の Queue のメッセージは payload が \"{}\" で、内容・種類・利用者 ID を含まない。ほかの型は今までどおり", async () => {
    const a = await u.user();
    expect((await send(a, { category: "privacy_request", body: MARK })).status).toBe(204);
    await env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at) VALUES (?1, 'MeetupLeft', ?2, ?3)")
      .bind(crypto.randomUUID(), JSON.stringify({ meetupId: "m-1" }), h.clock.now)
      .run();
    await dispatchOutbox(h.ctx);
    const contact = h.jobs.find((j) => j.kind === "outbox" && j.type === "ContactMessageSubmitted");
    expect(contact).toMatchObject({ kind: "outbox", payload: "{}" });
    const text = JSON.stringify(contact);
    for (const secret of [MARK, a.id, "privacy_request"]) expect(text).not.toContain(secret);
    const other = h.jobs.find((j) => j.kind === "outbox" && j.type === "MeetupLeft");
    expect(other).toMatchObject({ payload: JSON.stringify({ meetupId: "m-1" }) });
  });

  it("toJobMessage（dispatch と E2E の drain の両方が使う）", () => {
    const row = { id: "r-1", type: "ContactMessageSubmitted", payload: JSON.stringify({ body: MARK }), created_at: 5 };
    expect(toJobMessage(row)).toEqual({ kind: "outbox", id: "r-1", type: "ContactMessageSubmitted", payload: "{}", createdAt: 5 });
    expect(toJobMessage({ ...row, type: "MeetupLeft" }).payload).toBe(row.payload);
  });

  it("NOTIFICATION_START_AT が未設定でも流す", async () => {
    const a = await u.user();
    expect((await send(a, { category: "bug", body: "a" })).status).toBe(204);
    const bindings = { ...h.bindings, NOTIFICATION_START_AT: "" } as Bindings;
    await dispatchOutbox({ env: bindings, deps: h.deps });
    expect(h.jobs.some((j) => j.kind === "outbox" && j.type === "ContactMessageSubmitted")).toBe(true);
  });
});

describe("届ける処理（振る舞い 3.・4.）", () => {
  async function submitted(email = "a-deliver@example.com", body = "内容") {
    const a = await userWithEmail(email);
    expect((await send(a, { category: "bug", body })).status).toBe(204);
    const [row] = await rowsOf(a.id);
    if (!row) throw new Error("no row");
    return { a, row };
  }

  it("Queue のメッセージの payload に偽の内容を入れても、D1 の行の内容を送る", async () => {
    const { row } = await submitted(undefined, "本当の内容");
    await deliverRow(row, JSON.stringify({ userId: crypto.randomUUID(), category: "other", body: "偽の内容" }));
    expect(h.slack.state.posts).toHaveLength(1);
    expect(h.slack.state.posts[0]?.body).toContain("本当の内容");
    expect(h.slack.state.posts[0]?.body).not.toContain("偽の内容");
  });

  it("1回だけ POST し、redirect は manual、text は種類だけ、blocks にすべての項目、すべて plain_text・emoji: false", async () => {
    const { a, row } = await submitted("a-blocks@example.com", "画面が\n止まります");
    await deliverRow(row);
    expect(h.slack.state.posts).toHaveLength(1);
    const post = h.slack.state.posts[0];
    expect(post?.url).toBe("https://hooks.slack.com/services/TEST/TEST/test");
    expect(post?.redirect).toBe("manual");
    expect(post?.contentType).toBe("application/json");
    const json = post?.json as SlackJson;
    expect(json.text).toBe("問い合わせ：不具合");
    expect(json.unfurl_links).toBe(false);
    expect(json.unfurl_media).toBe(false);
    expect(json.blocks).toEqual([
      { type: "header", text: { type: "plain_text", text: "問い合わせ：不具合", emoji: false } },
      {
        type: "section",
        fields: [
          { type: "plain_text", text: "返信先：a-blocks@example.com", emoji: false },
          { type: "plain_text", text: "受付：2026-10-10 09:00（日本時間）", emoji: false },
          { type: "plain_text", text: `利用者ID：${a.id}`, emoji: false },
          { type: "plain_text", text: `受付番号：${row.id}`, emoji: false },
        ],
      },
      { type: "section", text: { type: "plain_text", text: "画面が\n止まります", emoji: false } },
    ]);
  });

  it("エスケープ：<!channel>・<!here>・<@U123>・<URL|文字>・& は &lt;・&gt;・&amp; になる。メールアドレスの欄も同じ", async () => {
    const { row } = await submitted("a<b>&c@example.com", "<!channel> <!here> <@U123> <https://example.com|押して> & @channel");
    await deliverRow(row);
    const body = h.slack.state.posts[0]?.body ?? "";
    const json = h.slack.state.posts[0]?.json as SlackJson;
    const texts = json.blocks.flatMap((b) => [b.text?.text ?? "", ...(b.fields ?? []).map((f) => f.text)]);
    expect(texts.join("\n")).not.toMatch(/[<>]/);
    expect(json.blocks.at(-1)?.text?.text).toBe(
      "&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;https://example.com|押して&gt; &amp; @channel",
    );
    expect(body).toContain("返信先：a&lt;b&gt;&amp;c@example.com");
  });

  it("長い内容は section が2つに分かれる（3000文字以下）", async () => {
    const { row } = await submitted(undefined, "&".repeat(CONTACT_BODY_MAX));
    await deliverRow(row);
    const json = h.slack.state.posts[0]?.json as SlackJson;
    const sections = json.blocks.slice(2).map((b) => b.text?.text ?? "");
    expect(sections).toHaveLength(2);
    expect(sections.every((s) => s.length <= 3000)).toBe(true);
    expect(sections.join("")).toBe("&amp;".repeat(CONTACT_BODY_MAX));
  });

  it("返信先がないと「返信先：登録なし」", async () => {
    const { a, row } = await submitted("a-null@example.com");
    await env.DB.prepare("UPDATE users SET email = NULL WHERE id = ?").bind(a.id).run();
    await deliverRow(row);
    expect(h.slack.state.posts[0]?.body).toContain("返信先：登録なし");
  });

  it("届けたら payload が userId・occurredAt・delivered だけになり、もう一度処理しても送らない", async () => {
    const { a, row } = await submitted();
    await deliverRow(row);
    await deliverRow(row);
    expect(h.slack.state.posts).toHaveLength(1);
    const [after] = await rowsOf(a.id);
    expect(JSON.parse(after?.payload ?? "")).toEqual({ userId: a.id, occurredAt: new Date(h.clock.now).toISOString(), delivered: true });
  });

  it("書き換えは delivered がない行だけ（先に書き換えた行を上書きしない）。行がなければ送らない", async () => {
    const { a, row } = await submitted();
    await redact(env.DB, row.id, { userId: a.id, occurredAt: "first", delivered: true });
    await redact(env.DB, row.id, { userId: a.id, occurredAt: "second", delivered: true });
    expect(JSON.parse((await rowsOf(a.id))[0]?.payload ?? "").occurredAt).toBe("first");
    await handleJob(h.ctx, { kind: "outbox", id: crypto.randomUUID(), type: "ContactMessageSubmitted", payload: "{}" });
    expect(h.slack.state.posts).toHaveLength(0);
  });

  it("送る前に退会していたら、送らずに内容を消す", async () => {
    const { a, row } = await submitted();
    await env.DB.prepare("UPDATE users SET withdrawn_at = ?, email = NULL WHERE id = ?").bind(h.clock.now, a.id).run();
    await deliverRow(row);
    expect(h.slack.state.posts).toHaveLength(0);
    expect(JSON.parse((await rowsOf(a.id))[0]?.payload ?? "")).toEqual({ userId: a.id, occurredAt: expect.any(String), delivered: true });
  });

  it("送る間に退会したら、contact_delivered_after_withdrawal を受付番号だけで warn で出す", async () => {
    const { a, row } = await submitted();
    h.slack.state.onPost = async () => {
      await env.DB.prepare("UPDATE users SET withdrawn_at = ?, email = NULL WHERE id = ?").bind(h.clock.now, a.id).run();
    };
    await deliverRow(row);
    expect(h.slack.state.posts).toHaveLength(1);
    expect(output).toContain(JSON.stringify({ event: "contact_delivered_after_withdrawal", id: row.id }));
  });

  it("失敗：200 以外・3xx・429・通信の失敗で投げ、payload は残る", async () => {
    const { a, row } = await submitted();
    for (const next of [500, 302, 429, 404, "throw"] as const) {
      h.slack.state.next.push(next);
      await expect(deliverRow(row), String(next)).rejects.toMatchObject({ name: "ContactWebhookRejected" });
    }
    expect(JSON.parse((await rowsOf(a.id))[0]?.payload ?? "").body).toBe("内容");
  });

  it("失敗：5秒で打ち切る", { timeout: 15_000 }, async () => {
    const { row } = await submitted();
    h.slack.state.next.push("hang");
    const started = Date.now();
    await expect(deliverRow(row)).rejects.toMatchObject({ name: "ContactWebhookRejected" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
  });

  it("URL が未設定・読めない・http・ホストが違う・ポート付き・/services/ で始まらないと、送らずに投げる", async () => {
    const { row } = await submitted();
    for (const url of [
      undefined,
      "",
      "not a url",
      "http://hooks.slack.com/services/T/B/x",
      "https://hooks.slack.com.example.com/services/T/B/x",
      "https://evil.example/services/T/B/x",
      "https://hooks.slack.com:8443/services/T/B/x",
      "https://hooks.slack.com/api/T/B/x",
      "https://user:pass@hooks.slack.com/services/T/B/x",
    ]) {
      const ctx = { env: { ...h.bindings, CONTACT_SLACK_WEBHOOK_URL: url } as Bindings, deps: h.deps };
      await expect(
        handleJob(ctx, { kind: "outbox", id: row.id, type: "ContactMessageSubmitted", payload: "{}" }),
        String(url),
      ).rejects.toMatchObject({ name: "ContactWebhookNotConfigured" });
    }
    expect(h.slack.state.posts).toHaveLength(0);
  });

  it("最後の試行で job_dead_lettered（type: ContactMessageSubmitted）が warn で出る", async () => {
    const { row } = await submitted();
    h.slack.state.next.push(500);
    const message = {
      body: toJobMessage({ ...row, type: "ContactMessageSubmitted" }),
      attempts: MAX_RETRIES + 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await handleBatch(h.ctx, { messages: [message] } as unknown as MessageBatch<JobMessage>);
    expect(message.retry).toHaveBeenCalled();
    expect(output).toContain(
      JSON.stringify({ event: "job_dead_lettered", kind: "outbox", type: "ContactMessageSubmitted", id: row.id, attempts: MAX_RETRIES + 1, error: "ContactWebhookRejected" }),
    );
  });

  it("許す宛先：既定は hooks.slack.com・/services/。本番のエントリでは差し替えていない", () => {
    expect(CONTACT_WEBHOOK_TARGET).toEqual({ hostname: "hooks.slack.com", pathPrefix: "/services/" });
    expect(defaultDeps().contactWebhookTarget).toEqual(CONTACT_WEBHOOK_TARGET);
    expect(indexSource).toContain("createWorker()");
    expect(indexSource).not.toContain("contactWebhookTarget");
  });

  it("お知らせを作らない", async () => {
    const { a, row } = await submitted();
    await deliverRow(row);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?").bind(a.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("ログ・例外に、内容・メールアドレス・利用者 ID・webhook の URL が出ない（成功・上限・失敗のどれでも）", async () => {
    const email = "mark-Zq81@example.com";
    const a = await userWithEmail(email);
    const errors: unknown[] = [];
    for (let i = 0; i < 4; i++) await send(a, { category: "bug", body: `${MARK}${i}` });
    const rows = await rowsOf(a.id);
    const [first, second, third] = rows;
    if (!first || !second || !third) throw new Error("rows");
    await deliverRow(first);
    h.slack.state.next.push(500);
    await deliverRow(second).catch((e: unknown) => errors.push(e));
    h.slack.state.next.push("throw");
    await deliverRow(third).catch((e: unknown) => errors.push(e));
    const bad = { env: { ...h.bindings, CONTACT_SLACK_WEBHOOK_URL: "https://evil.example/services/x" } as Bindings, deps: h.deps };
    await handleJob(bad, toJobMessage({ ...third, type: "ContactMessageSubmitted" })).catch((e: unknown) => errors.push(e));
    await handleBatch(h.ctx, {
      messages: [{ body: toJobMessage({ ...second, type: "ContactMessageSubmitted" }), attempts: MAX_RETRIES + 1, ack: vi.fn(), retry: vi.fn() }],
    } as unknown as MessageBatch<JobMessage>).catch(() => undefined);
    expect(errors).toHaveLength(3);
    const all = [...output, ...errors.map((e) => `${(e as Error).name} ${(e as Error).message} ${JSON.stringify(e)}`)].join("\n");
    for (const secret of [MARK, email, a.id, "hooks.slack.com", "evil.example", "TEST/TEST"]) expect(all).not.toContain(secret);
  });
});

describe("退会（振る舞い 5.）", () => {
  it("入口を止める段で、本人の行（処理済み・未処理とも）が消え、ほかの利用者の行は残る", async () => {
    const a = await u.user();
    const b = await u.user();
    expect((await send(a, { category: "bug", body: "1" })).status).toBe(204);
    expect((await send(a, { category: "bug", body: "2" })).status).toBe(204);
    expect((await send(b, { category: "bug", body: "b" })).status).toBe(204);
    const [processed] = await rowsOf(a.id);
    await env.DB.prepare("UPDATE outbox SET processed_at = ? WHERE id = ?").bind(h.clock.now, processed?.id).run();
    expect((await withdraw(a)).status).toBe(204);
    expect(await rowsOf(a.id)).toHaveLength(0);
    expect(await rowsOf(b.id)).toHaveLength(1);
  });
});
