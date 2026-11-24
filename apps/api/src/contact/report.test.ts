import { env } from "cloudflare:workers";
import { friendPageSchema, REPORT_DAILY_LIMIT } from "@kokohima/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { handleJob } from "../jobs/consumer";
import { ID_ONLY_TYPES, toJobMessage } from "../jobs/dispatch";
import { buildReportSlackMessage, formatJstRange } from "./domain/reportMessage";

// 通報（docs/specs/T-33-block-report.md「テスト計画」）。時計は 2026-10-10T00:00:00Z。始める日は、ほかのテストでは 0 にする
let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;
let output: string[];

beforeEach(async () => {
  h = await createHarness({ safetyStartAt: 0, contactStartAt: 0 });
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

const T = (s: string) => `2026-10-10T${s}:00.000Z`;
const PATH = "/api/v1/reports";
const MARK = "見分け用のくわしく-Rp27";

const report = (who: User, body: unknown, opts: { origin?: string | null; headers?: Record<string, string> } = {}) =>
  u.call("POST", PATH, { token: who.token, body, ...opts });

const rowsOf = async (userId: string) =>
  (
    await env.DB.prepare(
      "SELECT id, type, payload, created_at FROM outbox WHERE type = 'UserReported' AND json_extract(payload, '$.userId') = ? ORDER BY created_at, id",
    )
      .bind(userId)
      .all<{ id: string; type: string; payload: string; created_at: number }>()
  ).results;

const friendsOf = async (who: User) =>
  friendPageSchema.parse(await (await u.call("GET", "/api/v1/friends", { token: who.token })).json()).items.map((f) => f.id);

async function pair() {
  const a = await u.user("あき");
  const b = await u.user("びー");
  await u.befriend(a, b);
  return { a, b };
}

async function inviteFrom(from: User, to: User) {
  const res = await u.call("POST", "/api/v1/direct-invites", {
    token: from.token,
    body: { recipientId: to.id, startsAt: T("11:00"), endsAt: T("13:00"), message: "夜に二人で", url: "https://example.com/a?b=c&d=e", area: "渋谷" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const deliver = (row: { id: string; created_at: number }) =>
  handleJob(h.ctx, { kind: "outbox", id: row.id, type: "UserReported", payload: "{}", createdAt: row.created_at });

describe("受け付け（POST /reports）", () => {
  it("友達を通報すると204で、outbox に1行。ブロックもしないなら友達のまま。受け付けのログは出さない", async () => {
    const { a, b } = await pair();
    output = [];
    const res = await report(a, { userId: b.id, reason: "repeated_invites", details: ` ${MARK} `, alsoBlock: false });
    expect(res.status).toBe(204);
    const rows = await rowsOf(a.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? "")).toEqual({
      userId: a.id,
      targetUserId: b.id,
      reason: "repeated_invites",
      details: MARK,
      alsoBlock: false,
      subject: null,
      occurredAt: new Date(h.clock.now).toISOString(),
    });
    expect(await friendsOf(a)).toContain(b.id);
    expect(output).toEqual([]);
  });

  it("「ブロックもする」ならブロックし、友達の解除と同じになる", async () => {
    const { a, b } = await pair();
    expect((await report(a, { userId: b.id, reason: "other", alsoBlock: true })).status).toBe(204);
    expect(await friendsOf(a)).not.toContain(b.id);
    expect(await friendsOf(b)).not.toContain(a.id);
    const blocked = await env.DB.prepare("SELECT 1 AS x FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?2").bind(a.id, b.id).first();
    expect(blocked).not.toBeNull();
  });

  it("届いた誘いから通報すると、その誘いのひとこと・リンク・日時・エリアを対象として一緒に書く", async () => {
    const { a, b } = await pair();
    const id = await inviteFrom(b, a);
    expect((await report(a, { userId: b.id, reason: "unsafe_meetup", subject: { type: "direct_invite", id }, alsoBlock: true })).status).toBe(204);
    const p = JSON.parse((await rowsOf(a.id))[0]?.payload ?? "") as { subject: unknown };
    expect(p.subject).toEqual({
      type: "direct_invite",
      id,
      startsAt: T("11:00"),
      endsAt: T("13:00"),
      area: "渋谷",
      message: "夜に二人で",
      url: "https://example.com/a?b=c&d=e",
    });
    // 友達でなくなった（ブロックした）あとも、同じ誘いからならもう一度通報できる
    expect((await report(a, { userId: b.id, reason: "other", subject: { type: "direct_invite", id }, alsoBlock: false })).status).toBe(204);
    expect((await report(a, { userId: b.id, reason: "other", alsoBlock: false })).status).toBe(404);
  });

  it("届いた募集から通報できる", async () => {
    const { a, b } = await pair();
    const c = await u.user("しー");
    await u.befriend(b, c);
    const res = await u.call("POST", "/api/v1/broadcasts", {
      token: b.token,
      body: { recipientIds: [a.id, c.id], startsAt: T("11:00"), endsAt: T("13:00"), message: "だれか" },
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect((await report(a, { userId: b.id, reason: "offensive_content", subject: { type: "broadcast", id }, alsoBlock: false })).status).toBe(204);
    const p = JSON.parse((await rowsOf(a.id))[0]?.payload ?? "") as { subject: { message: string } };
    expect(p.subject.message).toBe("だれか");
  });

  it("他人の ID では操作できない：友達でない・存在しない・自分・送った側の誘い・送り主の違う対象は同じ404で、行ができない", async () => {
    const { a, b } = await pair();
    const c = await u.user("しー");
    const sentByA = await inviteFrom(a, b);
    const toA = await inviteFrom(b, a);
    for (const body of [
      { userId: c.id, reason: "other", alsoBlock: false },
      { userId: crypto.randomUUID(), reason: "other", alsoBlock: false },
      { userId: a.id, reason: "other", alsoBlock: false },
      { userId: b.id, reason: "other", subject: { type: "direct_invite", id: sentByA }, alsoBlock: false },
      { userId: c.id, reason: "other", subject: { type: "direct_invite", id: toA }, alsoBlock: true },
      { userId: b.id, reason: "other", subject: { type: "broadcast", id: toA }, alsoBlock: false },
    ]) {
      const res = await report(a, body);
      expect(res.status, JSON.stringify(body)).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
    }
    // c は a に届いた誘いを対象にできない
    expect((await report(c, { userId: b.id, reason: "other", subject: { type: "direct_invite", id: toA }, alsoBlock: true })).status).toBe(404);
    expect(await rowsOf(a.id)).toHaveLength(0);
    expect(await rowsOf(c.id)).toHaveLength(0);
    expect(await friendsOf(a)).toContain(b.id);
  });

  it("入力検証：知らない項目（送り主の指定を含む）・知らない理由・長すぎるくわしくは400", async () => {
    const { a, b } = await pair();
    for (const body of [
      { userId: b.id, reason: "other", alsoBlock: false, reporterId: a.id },
      { userId: b.id, reason: "spam", alsoBlock: false },
      { userId: b.id, reason: "other", details: "あ".repeat(1001), alsoBlock: false },
      { userId: b.id, reason: "other" },
    ]) {
      expect((await report(a, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await rowsOf(a.id)).toHaveLength(0);
  });

  it("回数の上限：直近24時間に5件まで。6件めは429と Retry-After で、ブロックもしない", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < REPORT_DAILY_LIMIT; i++) {
      expect((await report(a, { userId: b.id, reason: "other", alsoBlock: false })).status).toBe(204);
      h.clock.now += 60_000;
    }
    const res = await report(a, { userId: b.id, reason: "other", alsoBlock: true });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBe(24 * 60 * 60 - REPORT_DAILY_LIMIT * 60);
    expect(output.some((l) => l.includes('"group":"reports"'))).toBe(true);
    expect(output.join("\n")).not.toContain(a.id);
    expect(await friendsOf(a)).toContain(b.id);
    expect(await rowsOf(a.id)).toHaveLength(REPORT_DAILY_LIMIT);
  });

  it("問い合わせの回数とは別に数える", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 3; i++) {
      expect((await u.call("POST", "/api/v1/contact-messages", { token: a.token, body: { category: "other", body: "x" } })).status).toBe(204);
    }
    expect((await report(a, { userId: b.id, reason: "other", alsoBlock: false })).status).toBe(204);
  });

  it("同じ Idempotency-Key の再送は1件だけ", async () => {
    const { a, b } = await pair();
    const key = crypto.randomUUID();
    const body = { userId: b.id, reason: "other", alsoBlock: false };
    expect((await report(a, body, { headers: { "Idempotency-Key": key } })).status).toBe(204);
    expect((await report(a, body, { headers: { "Idempotency-Key": key } })).status).toBe(204);
    expect(await rowsOf(a.id)).toHaveLength(1);
  });

  it("Origin が違えば401。認証がなければ401", async () => {
    const { a, b } = await pair();
    expect((await report(a, { userId: b.id, reason: "other", alsoBlock: false }, { origin: "https://evil.example" })).status).toBe(401);
    expect((await u.call("POST", PATH, { body: { userId: b.id, reason: "other", alsoBlock: false } })).status).toBe(401);
  });

  it("通報したことは相手に伝わらない：相手あての outbox の行・お知らせができない", async () => {
    const { a, b } = await pair();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type != 'UserReported'").first<{ n: number }>();
    await report(a, { userId: b.id, reason: "other", alsoBlock: true });
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type != 'UserReported'").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const notes = await u.call("GET", "/api/v1/notifications", { token: b.token });
    expect(((await notes.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("始める日より前は、認証より前に知らない経路と同じ404", async () => {
    const { a, b } = await pair();
    const closed = await createHarness({ safetyStartAt: h.clock.now + 1 });
    const res = await closed.request(PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ userId: b.id, reason: "other", alsoBlock: false }),
    });
    expect(res.status).toBe(404);
  });
});

describe("届ける処理（振る舞い 5.）", () => {
  it("Queue のメッセージに中身を載せない", async () => {
    const { a, b } = await pair();
    await report(a, { userId: b.id, reason: "other", details: MARK, alsoBlock: false });
    const row = (await rowsOf(a.id))[0]!;
    expect(ID_ONLY_TYPES).toContain("UserReported");
    expect(toJobMessage({ ...row, payload: row.payload }).payload).toBe("{}");
  });

  it("Slack に1通送り、届けたら中身を消す（もう一度呼んでも送らない）。予定の中身・メールアドレスは送らない", async () => {
    const { a, b } = await pair();
    const id = await inviteFrom(b, a);
    await report(a, { userId: b.id, reason: "unsafe_meetup", details: MARK, subject: { type: "direct_invite", id }, alsoBlock: true });
    const row = (await rowsOf(a.id))[0]!;
    await deliver(row);
    await deliver(row);
    expect(h.slack.state.posts).toHaveLength(1);
    const body = h.slack.state.posts[0]?.body ?? "";
    expect(body).toContain("通報：会うのが不安な誘い");
    expect(body).toContain(MARK);
    expect(body).toContain(`通報された人：${b.id}`);
    expect(body).toContain("夜に二人で");
    expect(body).toContain("b=c&amp;d=e");
    expect(body).not.toContain("@example");
    expect(JSON.parse((await rowsOf(a.id))[0]?.payload ?? "")).toEqual({ userId: a.id, occurredAt: new Date(row.created_at).toISOString(), delivered: true });
    expect(output.join("\n")).not.toContain(MARK);
  });

  it("届ける前に通報した人が退会していたら送らずに消す。退会で未処理の行も消える", async () => {
    const { a, b } = await pair();
    await report(a, { userId: b.id, reason: "other", details: MARK, alsoBlock: false });
    const row = (await rowsOf(a.id))[0]!;
    await env.DB.prepare("UPDATE users SET withdrawn_at = ?2 WHERE id = ?1").bind(a.id, h.clock.now).run();
    await deliver(row);
    expect(h.slack.state.posts).toHaveLength(0);
    expect((await rowsOf(a.id))[0]?.payload).not.toContain(MARK);

    const { PERSONAL_OUTBOX_TYPES } = await import("../identity/infra/repository");
    expect(PERSONAL_OUTBOX_TYPES).toContain("UserReported");
  });

  it("Slack が失敗したら投げて再試行に任せ、中身は残す", async () => {
    const { a, b } = await pair();
    await report(a, { userId: b.id, reason: "other", details: MARK, alsoBlock: false });
    const row = (await rowsOf(a.id))[0]!;
    h.slack.state.next.push(500);
    await expect(deliver(row)).rejects.toThrow();
    expect((await rowsOf(a.id))[0]?.payload).toContain(MARK);
  });
});

describe("Slack に送る文", () => {
  it("理由・通報した人・された人・受付番号を出し、くわしくと相手の書いたものは plain_text でエスケープする", () => {
    const m = buildReportSlackMessage({
      reason: "offensive_content",
      reporterId: "r",
      targetUserId: "t",
      occurredAt: "2026-10-10T00:00:00.000Z",
      receiptId: "rid",
      details: "<!channel> & x",
      alsoBlock: false,
      subject: {
        type: "broadcast",
        id: "bid",
        startsAt: "2026-10-10T02:00:00.000Z",
        endsAt: "2026-10-10T04:00:00.000Z",
        area: null,
        message: "<@U1>",
        url: null,
      },
    });
    expect(m.text).toBe("通報：ひとこと・リンクが不快");
    expect(m.unfurl_links).toBe(false);
    const json = JSON.stringify(m);
    expect(json).toContain("&lt;!channel&gt; &amp; x");
    expect(json).toContain("&lt;@U1&gt;");
    expect(json).toContain("対象：募集（bid）");
    expect(json).toContain("ブロック：していない");
    expect(json).not.toContain('"type":"mrkdwn"');
  });

  it("日時は日本時間。同じ日なら終わりは時刻だけ", () => {
    expect(formatJstRange("2026-10-10T02:00:00.000Z", "2026-10-10T04:00:00.000Z")).toBe("2026-10-10 11:00〜13:00（日本時間）");
    expect(formatJstRange("2026-10-10T14:00:00.000Z", "2026-10-10T16:00:00.000Z")).toBe("2026-10-10 23:00〜2026-10-11 01:00（日本時間）");
  });

  it("長いくわしくは3000文字ずつの section に分かれる", () => {
    const m = buildReportSlackMessage({
      reason: "other",
      reporterId: "r",
      targetUserId: "t",
      occurredAt: "2026-10-10T00:00:00.000Z",
      receiptId: "rid",
      details: "&".repeat(1000),
      alsoBlock: true,
      subject: null,
    });
    for (const b of m.blocks) if (b.type === "section" && "text" in b && b.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
  });
});
