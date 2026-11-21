import { env } from "cloudflare:workers";
import { broadcastSchema, directInviteSchema, meetupSchema, type LinkPreview } from "@kokohima/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html } from "../../test/fake-web";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { dispatchOutbox, cleanupExpired } from "../jobs/dispatch";
import { handleBatch, handleJob, MAX_RETRIES } from "../jobs/consumer";
import { images } from "../../test/images";
import { TransientError } from "./domain/url";
import { handleLinkAttached } from "./application/fetchPreview";
import { resolveDoh } from "./infra/dns";
import { defaultDeps } from "../app";

// リンクのプレビュー（docs/specs/T-08-link-preview.md「テスト計画」）。時計は 2026-10-10T00:00:00Z
// テストの間で DB は共有されるので、URL のホストはテストごとに変える

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const host = () => `site-${crypto.randomUUID().slice(0, 8)}.example.com`;
const ogpHead = (title = "タイトル", image?: string) =>
  `<meta property="og:title" content="${title}"><meta property="og:description" content="説明"><meta property="og:site_name" content="サイト">${image ? `<meta property="og:image" content="${image}">` : ""}`;

async function pair() {
  const a = await u.user("あき");
  const b = await u.user("はる");
  await u.befriend(a, b);
  return { a, b };
}

let slot = 0;
/** 同じ時間の誘いにならないよう、テストごとに時刻をずらす */
function nextRange() {
  slot = (slot + 1) % 40;
  const start = Math.ceil(h.clock.now / HOUR) * HOUR + DAY + slot * HOUR;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + HOUR).toISOString() };
}

async function invite(from: User, to: User, url: string | null) {
  const res = await u.call("POST", "/api/v1/direct-invites", {
    token: from.token,
    body: { recipientId: to.id, ...nextRange(), ...(url !== null ? { url } : {}) },
  });
  expect(res.status).toBe(201);
  return directInviteSchema.parse(await res.json());
}

const getInvite = async (who: User, id: string) =>
  directInviteSchema.parse(await (await u.call("GET", `/api/v1/direct-invites/${id}`, { token: who.token })).json());

/** その誘い・募集の LinkAttached の行 */
async function linkEvents(subjectId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, payload, created_at FROM outbox WHERE type = 'LinkAttached' AND json_extract(payload, '$.subjectId') = ?1",
  )
    .bind(subjectId)
    .all<{ id: string; payload: string; created_at: number }>();
  return results;
}

/** LinkAttached を consumer に直接渡す（Queue を通さない）。attempts を渡すと試行の回数として使う */
async function deliver(subjectId: string, attempts?: number) {
  for (const e of await linkEvents(subjectId)) {
    await handleJob(h.ctx, { kind: "outbox", id: e.id, type: "LinkAttached", payload: e.payload, createdAt: e.created_at }, attempts);
  }
}

const previewRows = (hash: string) =>
  env.DB.prepare("SELECT * FROM link_previews WHERE url_hash = ?1").bind(hash).all<{ id: string; status: string; image_id: string | null; claimed_at: number; fetched_at: number | null }>();

async function hashOf(url: string) {
  const { sha256 } = await import("../shared/crypto");
  return sha256(url);
}

const okPreview = (p: Partial<LinkPreview> = {}): LinkPreview => ({
  status: "ok",
  title: "タイトル",
  description: "説明",
  siteName: "サイト",
  imageUrl: null,
  ...p,
});

describe("取得から表示まで", () => {
  it("リンク付きの誘いは、処理するまで pending、処理したらカードの項目が出る。画像は R2 から配信される", async () => {
    const { a, b } = await pair();
    const site = host();
    const url = `https://${site}/page`;
    h.web.page(url, () => html(ogpHead("タイトル", "/og.png")));
    const png = images.png(120, 60);
    h.web.page(`https://${site}/og.png`, () => new Response(png, { headers: { "Content-Type": "image/png" } }));
    const created = await invite(a, b, url);
    expect(created.linkPreview).toEqual({ status: "pending", title: null, description: null, siteName: null, imageUrl: null });

    await deliver(created.id, 1);
    const seen = await getInvite(b, created.id);
    expect(seen.linkPreview).toMatchObject({ status: "ok", title: "タイトル", description: "説明", siteName: "サイト" });
    const imageUrl = seen.linkPreview?.imageUrl ?? "";
    expect(imageUrl).toMatch(/^\/api\/v1\/link-previews\/images\/[0-9a-f-]{36}$/);
    expect((await getInvite(a, created.id)).linkPreview).toEqual(seen.linkPreview);

    const image = await u.call("GET", imageUrl, { headers: { "CF-Connecting-IP": "203.0.113.7" } });
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    expect(Object.fromEntries(["Content-Type", "X-Content-Type-Options", "Content-Security-Policy", "Cache-Control", "Cross-Origin-Resource-Policy", "Content-Disposition"].map((k) => [k, image.headers.get(k)]))).toEqual({
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=86400, immutable",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": "inline",
    });
    const imageId = imageUrl.split("/").pop() ?? "";
    const stored = await env.OGP_IMAGES.get(`images/v1/${imageId}`);
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
  });

  it("取得の要求に Cookie・Authorization・Referer を付けない。UA と Accept を付け、redirect は manual", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/`;
    h.web.page(url, () => html(ogpHead()));
    await deliver((await invite(a, b, url)).id, 1);
    const req = h.web.requests.find((r) => r.url === url);
    const headers = new Headers(req?.init?.headers);
    expect(headers.get("User-Agent")).toBe("kokohima-link-preview/1.0");
    expect(headers.get("Accept")).toBe("text/html,application/xhtml+xml");
    expect(headers.get("Accept-Language")).toBe("ja");
    expect(headers.has("Cookie") || headers.has("Authorization") || headers.has("Referer")).toBe(false);
    expect(req?.init?.redirect).toBe("manual");
  });

  it("リンクがない誘いは linkPreview が null で、LinkAttached を書かない", async () => {
    const { a, b } = await pair();
    const created = await invite(a, b, null);
    expect(created.linkPreview).toBeNull();
    expect(await linkEvents(created.id)).toHaveLength(0);
  });

  it("LinkAttached の payload は ID と時刻だけ（URL を入れない）。NOTIFICATION_START_AT が空でも流れる", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/secret-path?q=1`;
    const created = await invite(a, b, url);
    const [event] = await linkEvents(created.id);
    expect(JSON.parse(event?.payload ?? "{}")).toEqual({ subjectType: "direct_invite", subjectId: created.id, occurredAt: expect.any(String) });
    expect(event?.payload).not.toContain(url);
    // 通知を有効にしていない環境でも、LinkAttached は取り出す
    const bindings = { ...h.bindings, NOTIFICATION_START_AT: "" };
    await dispatchOutbox({ env: bindings, deps: h.deps });
    expect(h.jobs.some((j) => j.kind === "outbox" && j.type === "LinkAttached" && j.id === event?.id)).toBe(true);
  });

  it("送信が拒否された（友達でない・同じ誘い）ときは LinkAttached を書かない", async () => {
    const { a, b } = await pair();
    const stranger = await u.user();
    const url = `https://${host()}/`;
    const res = await u.call("POST", "/api/v1/direct-invites", { token: a.token, body: { recipientId: stranger.id, ...nextRange(), url } });
    expect(res.status).toBe(404);
    const range = nextRange();
    const first = await u.call("POST", "/api/v1/direct-invites", { token: a.token, body: { recipientId: b.id, ...range, url } });
    expect(first.status).toBe(201);
    const dup = await u.call("POST", "/api/v1/direct-invites", { token: a.token, body: { recipientId: b.id, ...range, url } });
    expect(dup.status).toBe(409);
    const { results } = await env.DB.prepare(
      "SELECT o.id FROM outbox o WHERE o.type = 'LinkAttached' AND NOT EXISTS (SELECT 1 FROM direct_invites i WHERE i.id = json_extract(o.payload, '$.subjectId')) AND NOT EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = json_extract(o.payload, '$.subjectId'))",
    ).all();
    expect(results).toHaveLength(0);
  });

  it("送信上限に達した送信でも LinkAttached を書かない", async () => {
    const { a, b } = await pair();
    let accepted = 0;
    for (let i = 0; i < 25; i++) {
      const res = await u.call("POST", "/api/v1/direct-invites", { token: a.token, body: { recipientId: b.id, ...nextRange(), url: `https://${host()}/` } });
      if (res.status === 201) accepted++;
      else expect(res.status).toBe(429);
    }
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox o JOIN direct_invites i ON i.id = json_extract(o.payload, '$.subjectId') WHERE o.type = 'LinkAttached' AND i.sender_id = ?1",
    )
      .bind(a.id)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(accepted);
    const all = await env.DB.prepare("SELECT COUNT(*) AS n FROM direct_invites WHERE sender_id = ?1").bind(a.id).first<{ n: number }>();
    expect(all?.n).toBe(accepted);
  });

  it("募集のリンクも、宛先の人と募集者に同じプレビューが出る", async () => {
    const owner = await u.user("あき");
    const f1 = await u.user();
    const f2 = await u.user();
    await u.befriend(owner, f1);
    await u.befriend(owner, f2);
    const url = `https://${host()}/b`;
    h.web.page(url, () => html(ogpHead("募集のページ")));
    const res = await u.call("POST", "/api/v1/broadcasts", { token: owner.token, body: { recipientIds: [f1.id, f2.id], ...nextRange(), url } });
    expect(res.status).toBe(201);
    const created = broadcastSchema.parse(await res.json());
    expect(created.linkPreview?.status).toBe("pending");
    const [event] = await linkEvents(created.id);
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({ subjectType: "broadcast", subjectId: created.id });
    await deliver(created.id, 1);
    for (const who of [owner, f1, f2]) {
      const b = broadcastSchema.parse(await (await u.call("GET", `/api/v1/broadcasts/${created.id}`, { token: who.token })).json());
      expect(b.linkPreview).toEqual(okPreview({ title: "募集のページ" }));
    }
    const list = await u.call("GET", "/api/v1/broadcasts?box=received", { token: f1.token });
    const items = ((await list.json()) as { items: { id: string; linkPreview: unknown }[] }).items;
    expect(items.find((i) => i.id === created.id)?.linkPreview).toEqual(okPreview({ title: "募集のページ" }));
  });

  it("成立した予定は、元の誘いのプレビューを使う。一覧にも出る", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/m`;
    h.web.page(url, () => html(ogpHead("予定のページ")));
    const created = await invite(a, b, url);
    await deliver(created.id, 1);
    const res = await u.call("POST", `/api/v1/direct-invites/${created.id}/responses`, { token: b.token, body: { response: "accept" } });
    const accepted = directInviteSchema.parse(await res.json());
    const meetup = meetupSchema.parse(await (await u.call("GET", `/api/v1/meetups/${accepted.meetupId}`, { token: a.token })).json());
    expect(meetup.linkPreview).toEqual(okPreview({ title: "予定のページ" }));
    const list = (await (await u.call("GET", "/api/v1/meetups", { token: b.token })).json()) as { items: { id: string; linkPreview: unknown }[] };
    expect(list.items.find((m) => m.id === meetup.id)?.linkPreview).toEqual(okPreview({ title: "予定のページ" }));
    const invites = (await (await u.call("GET", "/api/v1/direct-invites?box=sent", { token: a.token })).json()) as { items: { id: string; linkPreview: unknown }[] };
    expect(invites.items.find((i) => i.id === created.id)?.linkPreview).toEqual(okPreview({ title: "予定のページ" }));
  });

  it("他人の ID では取得できない：誘い・募集・予定を見られない人には404（プレビューも出ない）", async () => {
    const { a, b } = await pair();
    const c = await u.user();
    const url = `https://${host()}/`;
    h.web.page(url, () => html(ogpHead()));
    const created = await invite(a, b, url);
    await deliver(created.id, 1);
    const res = await u.call("GET", `/api/v1/direct-invites/${created.id}`, { token: c.token });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("タイトル");
    const list = await (await u.call("GET", "/api/v1/direct-invites?box=received", { token: c.token })).text();
    expect(list).not.toContain(created.id);
  });

  it("pending・failed のときは項目がすべて null。T-08 より前の誘い（参照の行がない）は pending", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/missing`;
    h.web.page(url, () => new Response("no", { status: 404 }));
    const created = await invite(a, b, url);
    await deliver(created.id, 1);
    expect((await getInvite(b, created.id)).linkPreview).toEqual({ status: "failed", title: null, description: null, siteName: null, imageUrl: null });
    // 参照の行のない誘い（T-08 より前）
    const old = await invite(a, b, `https://${host()}/old`);
    await env.DB.prepare("DELETE FROM outbox WHERE type = 'LinkAttached' AND json_extract(payload, '$.subjectId') = ?1").bind(old.id).run();
    expect((await getInvite(b, old.id)).linkPreview?.status).toBe("pending");
  });
});

describe("同じ URL", () => {
  it("2回送っても取得は1回。2つめは使い回すが、処理するまでは pending", async () => {
    const { a, b } = await pair();
    const site = host();
    const url = `https://${site}/same`;
    h.web.page(url, () => html(ogpHead()));
    const first = await invite(a, b, url);
    await deliver(first.id, 1);
    const second = await invite(a, b, url);
    expect(second.linkPreview?.status).toBe("pending");
    expect((await getInvite(b, second.id)).linkPreview?.status).toBe("pending");
    await deliver(second.id, 1);
    expect((await getInvite(b, second.id)).linkPreview).toEqual(okPreview());
    expect(h.web.countFor(site)).toBe(1);
    // 同じメッセージがもう一度届いても何もしない
    await deliver(second.id, 2);
    expect(h.web.countFor(site)).toBe(1);
  });

  it("フラグメントだけが違う URL は同じ URL として扱う", async () => {
    const { a, b } = await pair();
    const site = host();
    h.web.page(`https://${site}/f`, () => html(ogpHead()));
    await deliver((await invite(a, b, `https://${site}/f#a`)).id, 1);
    await deliver((await invite(a, b, `https://${site}/f#b`)).id, 1);
    expect(h.web.countFor(site)).toBe(1);
  });

  it("7日を過ぎた ok、24時間を過ぎた failed は取り直す", async () => {
    const { a, b } = await pair();
    const okSite = host();
    h.web.page(`https://${okSite}/`, () => html(ogpHead()));
    await deliver((await invite(a, b, `https://${okSite}/`)).id, 1);
    const failSite = host();
    h.web.page(`https://${failSite}/`, () => new Response("x", { status: 404 }));
    await deliver((await invite(a, b, `https://${failSite}/`)).id, 1);

    await u.advance(23 * HOUR, a, b);
    await deliver((await invite(a, b, `https://${okSite}/`)).id, 1);
    await deliver((await invite(a, b, `https://${failSite}/`)).id, 1);
    expect([h.web.countFor(okSite), h.web.countFor(failSite)]).toEqual([1, 1]);

    await u.advance(2 * HOUR, a, b);
    await deliver((await invite(a, b, `https://${failSite}/`)).id, 1);
    expect(h.web.countFor(failSite)).toBe(2);

    await u.advance(7 * DAY, a, b);
    await deliver((await invite(a, b, `https://${okSite}/`)).id, 1);
    expect(h.web.countFor(okSite)).toBe(2);
  });

  it("同時に2つ処理しても取得は1回。2つめは一時的な失敗のあと使い回す", async () => {
    const { a, b } = await pair();
    const site = host();
    const url = `https://${site}/slow`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.web.page(url, async () => {
      await gate;
      return html(ogpHead());
    });
    h.deps.linkPreview = { ...h.deps.linkPreview, timeouts: { fetchMs: 5000, totalMs: 5000, dnsMs: 300 } };
    const first = await invite(a, b, url);
    const second = await invite(a, b, url);
    const running = deliver(first.id, 1);
    // 1つめが取得中（権利を持っている）の間に2つめを処理する
    await vi.waitFor(() => expect(h.web.countFor(site)).toBe(1));
    await expect(deliver(second.id, 1)).rejects.toBeInstanceOf(TransientError);
    release();
    await running;
    await deliver(second.id, 2);
    expect((await getInvite(b, second.id)).linkPreview).toEqual(okPreview());
    expect(h.web.countFor(site)).toBe(1);
  });

  it("10分を過ぎた fetching の行は引き継ぐ", async () => {
    const { a, b } = await pair();
    const site = host();
    const url = `https://${site}/stale`;
    h.web.page(url, () => html(ogpHead()));
    const hash = await hashOf(url);
    await env.DB.prepare("INSERT INTO link_previews (id, url_hash, status, claimed_at) VALUES (?1, ?2, 'fetching', ?3)")
      .bind(crypto.randomUUID(), hash, h.clock.now - 11 * MIN)
      .run();
    const created = await invite(a, b, url);
    await deliver(created.id, 1);
    expect((await getInvite(b, created.id)).linkPreview).toEqual(okPreview());
    const rows = (await previewRows(hash)).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ok");
  });

  it("10分以内の fetching の行があれば一時的な失敗。最後の試行では failed にして投げない", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/busy`;
    const hash = await hashOf(url);
    await env.DB.prepare("INSERT INTO link_previews (id, url_hash, status, claimed_at) VALUES (?1, ?2, 'fetching', ?3)")
      .bind(crypto.randomUUID(), hash, h.clock.now - 5 * MIN)
      .run();
    const created = await invite(a, b, url);
    await expect(deliver(created.id, 1)).rejects.toBeInstanceOf(TransientError);
    await deliver(created.id, MAX_RETRIES + 1);
    expect((await getInvite(b, created.id)).linkPreview?.status).toBe("failed");
  });
});

describe("一時的な失敗と再試行", () => {
  it("5xx・429 は投げ、権利を手放すので、同じメッセージの次の試行で取りに行ける", async () => {
    const { a, b } = await pair();
    const site = host();
    const url = `https://${site}/flaky`;
    const statuses = [503, 429];
    h.web.page(url, () => {
      const s = statuses.shift();
      return s ? new Response("x", { status: s }) : html(ogpHead());
    });
    const created = await invite(a, b, url);
    const hash = await hashOf(url);
    await expect(deliver(created.id, 1)).rejects.toBeInstanceOf(TransientError);
    expect((await previewRows(hash)).results).toHaveLength(0);
    await expect(deliver(created.id, 2)).rejects.toBeInstanceOf(TransientError);
    await deliver(created.id, 3);
    expect((await getInvite(b, created.id)).linkPreview).toEqual(okPreview());
  });

  it("引き継がれた後は、元の処理が手放しても引き継いだ側の行を消さない", async () => {
    const { release, claim, takeOver } = await import("./infra/repository");
    const hash = `test-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    expect(await claim(env.DB, id, hash, 1000)).toBe(true);
    expect(await takeOver(env.DB, hash, 2000, 3000)).toBe(id);
    await release(env.DB, id, 1000);
    expect((await previewRows(hash)).results).toEqual([expect.objectContaining({ id, status: "fetching", claimed_at: 3000 })]);
  });

  it("最後の試行（6回め）の失敗で、権利の行を failed にして参照し、投げない", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/down`;
    h.web.page(url, () => new Response("x", { status: 500 }));
    const created = await invite(a, b, url);
    await expect(deliver(created.id, MAX_RETRIES)).rejects.toBeInstanceOf(TransientError);
    await deliver(created.id, MAX_RETRIES + 1);
    expect((await getInvite(b, created.id)).linkPreview?.status).toBe("failed");
    const rows = (await previewRows(await hashOf(url))).results;
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
  });

  it("試行の回数がない呼び出し（E2E の drain）は最後の試行として扱わない", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/down2`;
    h.web.page(url, () => new Response("x", { status: 500 }));
    const created = await invite(a, b, url);
    await expect(deliver(created.id)).rejects.toBeInstanceOf(TransientError);
    expect((await getInvite(b, created.id)).linkPreview?.status).toBe("pending");
  });

  it("consumer の batch：最後の試行の失敗は ack して退避キューに送らない", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/down3`;
    h.web.page(url, () => new Response("x", { status: 502 }));
    const created = await invite(a, b, url);
    const [e] = await linkEvents(created.id);
    const make = (attempts: number) => {
      const m = { ack: vi.fn(), retry: vi.fn(), attempts, body: { kind: "outbox" as const, id: e?.id ?? "", type: "LinkAttached", payload: e?.payload ?? "" } };
      return m;
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const early = make(1);
    await handleBatch(h.ctx, { messages: [early] } as unknown as MessageBatch<never>);
    expect(early.retry).toHaveBeenCalled();
    const last = make(MAX_RETRIES + 1);
    await handleBatch(h.ctx, { messages: [last] } as unknown as MessageBatch<never>);
    expect(last.ack).toHaveBeenCalled();
    expect(last.retry).not.toHaveBeenCalled();
  });

  it("タイムアウト（本文を読み終えるまで）は一時的な失敗", async () => {
    const { a, b } = await pair();
    const url = `https://${host()}/hang`;
    h.web.page(url, () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("<html><head>")); } }), { headers: { "Content-Type": "text/html" } }));
    const created = await invite(a, b, url);
    await expect(deliver(created.id, 1)).rejects.toBeInstanceOf(TransientError);
  });

  it("LINK_PREVIEW_OWN_DOMAINS が空なら取りに行かず一時的な失敗、最後の試行では failed", async () => {
    const { a, b } = await pair();
    const site = host();
    const url = `https://${site}/`;
    h.web.page(url, () => html(ogpHead()));
    const created = await invite(a, b, url);
    const ctx = { env: { ...h.bindings, LINK_PREVIEW_OWN_DOMAINS: "" }, deps: h.deps };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(handleLinkAttached(ctx, { type: "direct_invite", id: created.id }, false)).rejects.toBeInstanceOf(TransientError);
    await handleLinkAttached(ctx, { type: "direct_invite", id: created.id }, true);
    expect(h.web.countFor(site)).toBe(0);
    expect((await getInvite(b, created.id)).linkPreview?.status).toBe("failed");
  });
});

describe("取りに行かない URL", () => {
  it("内部のアドレスに引ける名前は取らない（A・AAAA のどれか1つでも）", async () => {
    const { a, b } = await pair();
    for (const answer of [{ a: ["10.0.0.5"] }, { a: ["93.184.216.34"], aaaa: ["::1"] }, { a: ["93.184.216.34", "169.254.169.254"] }, { a: [] as string[] }]) {
      const site = host();
      h.web.page(`https://${site}/`, () => html(ogpHead()), answer);
      const created = await invite(a, b, `https://${site}/`);
      await deliver(created.id, 1);
      expect((await getInvite(b, created.id)).linkPreview?.status).toBe("failed");
      expect(h.web.countFor(site)).toBe(0);
    }
  });

  it("CNAME の data は使わない。読めない値があれば取らない", async () => {
    const { a, b } = await pair();
    const site = host();
    h.web.page(`https://${site}/`, () => html(ogpHead()), { answers: [{ type: 5, data: "internal.example.com." }, { type: 1, data: 1234 }] });
    const created = await invite(a, b, `https://${site}/`);
    await deliver(created.id, 1);
    expect((await getInvite(b, created.id)).linkPreview?.status).toBe("failed");
    const cname = host();
    h.web.page(`https://${cname}/`, () => html(ogpHead()), { answers: [{ type: 5, data: "93.184.216.34" }] });
    const c2 = await invite(a, b, `https://${cname}/`);
    await deliver(c2.id, 1);
    expect((await getInvite(b, c2.id)).linkPreview?.status).toBe("failed");
  });

  it("NXDOMAIN は failed、SERVFAIL・DoH の失敗は一時的な失敗", async () => {
    const { a, b } = await pair();
    const nx = host();
    h.web.page(`https://${nx}/`, () => html(ogpHead()), { status: 3 });
    const c1 = await invite(a, b, `https://${nx}/`);
    await deliver(c1.id, 1);
    expect((await getInvite(b, c1.id)).linkPreview?.status).toBe("failed");
    const sf = host();
    h.web.page(`https://${sf}/`, () => html(ogpHead()), { status: 2 });
    await expect(deliver((await invite(a, b, `https://${sf}/`)).id, 1)).rejects.toBeInstanceOf(TransientError);
    const down = host();
    h.web.page(`https://${down}/`, () => html(ogpHead()), { fail: true });
    await expect(deliver((await invite(a, b, `https://${down}/`)).id, 1)).rejects.toBeInstanceOf(TransientError);
  });

  it("リダイレクトは3回まで追い、4回めは failed。相対の Location を解決し、行き先も毎回検査する", async () => {
    const { a, b } = await pair();
    const site = host();
    const redirect = (to: string) => () => new Response(null, { status: 302, headers: { Location: to } });
    h.web.page(`https://${site}/r1`, redirect("/r2"));
    h.web.page(`https://${site}/r2`, redirect(`https://${site}/r3`));
    h.web.page(`https://${site}/r3`, redirect("r4"));
    h.web.page(`https://${site}/r4`, () => html(ogpHead("3回のあと")));
    h.web.page(`https://${site}/r0`, redirect("/r1"));
    const three = await invite(a, b, `https://${site}/r1`);
    await deliver(three.id, 1);
    expect((await getInvite(b, three.id)).linkPreview?.title).toBe("3回のあと");
    const four = await invite(a, b, `https://${site}/r0`);
    await deliver(four.id, 1);
    expect((await getInvite(b, four.id)).linkPreview?.status).toBe("failed");

    const toInternal = host();
    h.web.page(`https://${toInternal}/`, redirect("http://127.0.0.1/admin"));
    const c3 = await invite(a, b, `https://${toInternal}/`);
    await deliver(c3.id, 1);
    expect((await getInvite(b, c3.id)).linkPreview?.status).toBe("failed");
    const internalName = host();
    h.web.page(`https://${internalName}/`, () => html(ogpHead()), { a: ["192.168.0.10"] });
    const viaName = host();
    h.web.page(`https://${viaName}/`, redirect(`https://${internalName}/`));
    const c4 = await invite(a, b, `https://${viaName}/`);
    await deliver(c4.id, 1);
    expect((await getInvite(b, c4.id)).linkPreview?.status).toBe("failed");
    expect(h.web.countFor(internalName)).toBe(0);
  });

  it("HTML でない・4xx は failed。展開後の 512KB で止めても、先頭に OGP があれば取れる", async () => {
    const { a, b } = await pair();
    const json = host();
    h.web.page(`https://${json}/`, () => Response.json({ title: "x" }));
    const c1 = await invite(a, b, `https://${json}/`);
    await deliver(c1.id, 1);
    expect((await getInvite(b, c1.id)).linkPreview?.status).toBe("failed");

    const big = host();
    let pulled = 0;
    h.web.page(`https://${big}/`, () => {
      const head = new TextEncoder().encode(`<html><head>${ogpHead("大きいページ")}</head><body>`);
      const chunk = new Uint8Array(64 * 1024).fill(0x61);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(head);
          },
          pull(c) {
            pulled++;
            if (pulled > 200) c.close();
            else c.enqueue(chunk);
          },
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    });
    const c2 = await invite(a, b, `https://${big}/`);
    await deliver(c2.id, 1);
    expect((await getInvite(b, c2.id)).linkPreview?.title).toBe("大きいページ");
    expect(pulled).toBeLessThan(20);
  });

  it("Shift_JIS・EUC-JP・ISO-2022-JP のページを読める。知らない文字コードは failed", async () => {
    const { a, b } = await pair();
    // 「日本」をそれぞれの文字コードで
    const bodies: [string, number[]][] = [
      ["shift_jis", [0x93, 0xfa, 0x96, 0x7b]],
      ["euc-jp", [0xc6, 0xfc, 0xcb, 0xdc]],
      ["iso-2022-jp", [0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42]],
    ];
    for (const [charset, bytes] of bodies) {
      const site = host();
      const page = [...new TextEncoder().encode('<html><head><meta property="og:title" content="'), ...bytes, ...new TextEncoder().encode('"></head></html>')];
      h.web.page(`https://${site}/`, () => new Response(new Uint8Array(page), { headers: { "Content-Type": `text/html; charset=${charset}` } }));
      const created = await invite(a, b, `https://${site}/`);
      await deliver(created.id, 1);
      expect((await getInvite(b, created.id)).linkPreview?.title, charset).toBe("日本");
    }
    const meta = host();
    h.web.page(`https://${meta}/`, () => new Response(new Uint8Array([...new TextEncoder().encode('<html><head><meta charset="shift_jis"><title>'), 0x93, 0xfa, 0x96, 0x7b, ...new TextEncoder().encode("</title></head>")]), { headers: { "Content-Type": "text/html" } }));
    const c1 = await invite(a, b, `https://${meta}/`);
    await deliver(c1.id, 1);
    expect((await getInvite(b, c1.id)).linkPreview?.title).toBe("日本");
    const unknown = host();
    h.web.page(`https://${unknown}/`, () => html(ogpHead(), { contentType: "text/html; charset=x-unknown-charset" }));
    const c2 = await invite(a, b, `https://${unknown}/`);
    await deliver(c2.id, 1);
    expect((await getInvite(b, c2.id)).linkPreview?.status).toBe("failed");
  });
});

describe("画像", () => {
  async function withImage(respond: () => Response) {
    const { a, b } = await pair();
    const site = host();
    h.web.page(`https://${site}/`, () => html(ogpHead("ページ", "/img")));
    h.web.page(`https://${site}/img`, respond);
    const created = await invite(a, b, `https://${site}/`);
    await deliver(created.id, 1);
    return (await getInvite(b, created.id)).linkPreview;
  }

  it("SVG・HTML を画像と偽ったもの・2MB 超・4096超は画像なしで、ページは ok", async () => {
    const cases = [
      () => new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", { headers: { "Content-Type": "image/svg+xml" } }),
      () => new Response("<html><script>alert(1)</script>", { headers: { "Content-Type": "image/png" } }),
      () => new Response(images.png(10, 10), { headers: { "Content-Type": "image/jpeg" } }),
      () => {
        const big = new Uint8Array(2 * 1024 * 1024 + 10);
        big.set(images.png(10, 10));
        return new Response(big, { headers: { "Content-Type": "image/png" } });
      },
      () => new Response(images.png(5000, 10), { headers: { "Content-Type": "image/png" } }),
      () => new Response("x", { status: 500 }),
    ];
    for (const respond of cases) {
      expect(await withImage(respond)).toEqual(okPreview({ title: "ページ", siteName: "サイト", imageUrl: null }));
    }
  });

  it("画像の URL が内部を向いていたら取らない", async () => {
    const { a, b } = await pair();
    const site = host();
    h.web.page(`https://${site}/`, () => html(ogpHead("ページ", "http://169.254.169.254/latest")));
    const created = await invite(a, b, `https://${site}/`);
    await deliver(created.id, 1);
    expect((await getInvite(b, created.id)).linkPreview).toEqual(okPreview({ title: "ページ", imageUrl: null }));
  });
});

describe("画像の経路", () => {
  const get = (path: string) => u.call("GET", path, { headers: { "CF-Connecting-IP": "203.0.113.9" } });

  it("ない ID・壊れた ID・status が ok でない行の画像は404。認証は要らない", async () => {
    expect((await get(`/api/v1/link-previews/images/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await get("/api/v1/link-previews/images/not-a-uuid")).status).toBe(404);
    const imageId = crypto.randomUUID();
    await env.OGP_IMAGES.put(`images/v1/${imageId}`, images.png(1, 1), { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare("INSERT INTO link_previews (id, url_hash, status, image_id, image_type, claimed_at) VALUES (?1, ?2, 'fetching', ?3, 'image/png', 1)")
      .bind(crypto.randomUUID(), `h-${imageId}`, imageId)
      .run();
    expect((await get(`/api/v1/link-previews/images/${imageId}`)).status).toBe(404);
  });

  it("Rate Limiting の link_image（RL_PUBLIC・IP）。超えたら本文なしの429と Retry-After: 60", async () => {
    h.limiter.allow = () => false;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await get(`/api/v1/link-previews/images/${crypto.randomUUID()}`);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.text()).toBe("");
    expect(h.limiter.calls.at(-1)).toEqual({ limiter: "RL_PUBLIC", key: "link_image:ip4:203.0.113.9" });
  });
});

describe("誘い・募集が消えた", () => {
  it("処理の前に誘いが消えていたら、参照の行を書かずに投げずに終える", async () => {
    const { a, b } = await pair();
    const site = host();
    h.web.page(`https://${site}/`, () => html(ogpHead()));
    const created = await invite(a, b, `https://${site}/`);
    await env.DB.prepare("DELETE FROM direct_invites WHERE id = ?1").bind(created.id).run();
    await deliver(created.id, 1);
    expect(h.web.countFor(site)).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM link_preview_refs WHERE direct_invite_id = ?1").bind(created.id).first("n")).toBe(0);
  });

  it("処理の途中で消えたら、参照の行を書かずに終える。利用者を削除すると参照の行も消える", async () => {
    const { a, b } = await pair();
    const site = host();
    const created = await invite(a, b, `https://${site}/`);
    h.web.page(`https://${site}/`, async () => {
      await env.DB.prepare("DELETE FROM direct_invites WHERE id = ?1").bind(created.id).run();
      return html(ogpHead());
    });
    await deliver(created.id, 1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM link_preview_refs WHERE direct_invite_id = ?1").bind(created.id).first("n")).toBe(0);

    const kept = await invite(a, b, `https://${host()}/`);
    await deliver(kept.id, 1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM link_preview_refs WHERE direct_invite_id = ?1").bind(kept.id).first("n")).toBe(1);
    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(a.id).run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM link_preview_refs WHERE direct_invite_id = ?1").bind(kept.id).first("n")).toBe(0);
  });
});

describe("掃除", () => {
  const count = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<number>("n");

  it("参照されず30日を過ぎた ok・failed と、1時間を過ぎた fetching を消す。参照されている行・新しい行は消さない", async () => {
    const now = h.clock.now;
    const tag = crypto.randomUUID();
    const insert = (id: string, status: string, claimed: number, fetched: number | null) =>
      env.DB.prepare("INSERT INTO link_previews (id, url_hash, status, claimed_at, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(id, `${tag}-${id}`, status, claimed, fetched)
        .run();
    const ids = { oldOk: crypto.randomUUID(), oldFailed: crypto.randomUUID(), newOk: crypto.randomUUID(), oldFetching: crypto.randomUUID(), newFetching: crypto.randomUUID(), referenced: crypto.randomUUID() };
    await insert(ids.oldOk, "ok", now - 31 * DAY, now - 31 * DAY);
    await insert(ids.oldFailed, "failed", now - 31 * DAY, now - 31 * DAY);
    await insert(ids.newOk, "ok", now - 29 * DAY, now - 29 * DAY);
    await insert(ids.oldFetching, "fetching", now - 61 * MIN, null);
    await insert(ids.newFetching, "fetching", now - 59 * MIN, null);
    await insert(ids.referenced, "ok", now - 40 * DAY, now - 40 * DAY);
    const { a, b } = await pair();
    const inv = await invite(a, b, `https://${host()}/`);
    await env.DB.prepare("INSERT INTO link_preview_refs (id, direct_invite_id, preview_id, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(crypto.randomUUID(), inv.id, ids.referenced, now)
      .run();
    // 何度か回して上限つきの削除を進める
    for (let i = 0; i < 5; i++) await cleanupExpired(h.ctx);
    const left = await env.DB.prepare("SELECT id FROM link_previews WHERE url_hash LIKE ?1").bind(`${tag}-%`).all<{ id: string }>();
    expect(new Set(left.results.map((r) => r.id))).toEqual(new Set([ids.newOk, ids.newFetching, ids.referenced]));
  });

  it("台帳のうち1時間を過ぎて参照されない画像は R2 から消す。1時間以内・参照されている画像は消さない。R2 の削除に失敗したら台帳を残す", async () => {
    const now = h.clock.now;
    const put = async (imageId: string, createdAt: number) => {
      await env.DB.prepare("INSERT INTO link_preview_images (image_id, created_at) VALUES (?1, ?2)").bind(imageId, createdAt).run();
      await env.OGP_IMAGES.put(`images/v1/${imageId}`, images.png(1, 1));
    };
    const orphan = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    const used = crypto.randomUUID();
    await put(orphan, now - 2 * HOUR);
    await put(fresh, now - 30 * MIN);
    await put(used, now - 2 * HOUR);
    await env.DB.prepare("INSERT INTO link_previews (id, url_hash, status, image_id, image_type, claimed_at, fetched_at) VALUES (?1, ?2, 'ok', ?3, 'image/png', ?4, ?4)")
      .bind(crypto.randomUUID(), `img-${used}`, used, now)
      .run();

    const failing = { ...h.ctx, env: { ...h.bindings, OGP_IMAGES: { delete: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket } };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await cleanupExpired(failing);
    expect(await count("SELECT COUNT(*) AS n FROM link_preview_images WHERE image_id = ?1", orphan)).toBe(1);

    for (let i = 0; i < 5; i++) await cleanupExpired(h.ctx);
    expect(await count("SELECT COUNT(*) AS n FROM link_preview_images WHERE image_id = ?1", orphan)).toBe(0);
    expect(await env.OGP_IMAGES.get(`images/v1/${orphan}`)).toBeNull();
    expect(await env.OGP_IMAGES.get(`images/v1/${fresh}`)).not.toBeNull();
    expect(await env.OGP_IMAGES.get(`images/v1/${used}`)).not.toBeNull();
  });

  it("利用者の削除で参照がなくなった結果の行も、30日後に消える", async () => {
    const { a, b } = await pair();
    const site = host();
    h.web.page(`https://${site}/`, () => html(ogpHead()));
    const created = await invite(a, b, `https://${site}/`);
    await deliver(created.id, 1);
    const hash = await hashOf(`https://${site}/`);
    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(a.id).run();
    h.clock.now += 31 * DAY;
    for (let i = 0; i < 5; i++) await cleanupExpired(h.ctx);
    expect((await previewRows(hash)).results).toHaveLength(0);
  });
});

describe("既定の依存とログ", () => {
  it("既定の AppDeps では偽のホストを許さず、名前解決は本物の DoH を使う", () => {
    const deps = defaultDeps();
    expect(deps.linkPreview.extraHosts).toEqual([]);
    expect(deps.linkPreview.resolve).toBe(resolveDoh);
    expect(deps.linkPreview.timeouts).toEqual({ fetchMs: 5000, totalMs: 10_000, dnsMs: 3000 });
  });

  it("ログに URL・ホスト名・タイトルを出さない", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    const { a, b } = await pair();
    const site = host();
    h.web.page(`https://${site}/ok`, () => html(ogpHead("秘密のタイトル")));
    h.web.page(`https://${site}/err`, () => new Response("x", { status: 503 }));
    await deliver((await invite(a, b, `https://${site}/ok`)).id, 1);
    await deliver((await invite(a, b, `https://${site}/err`)).id, 1).catch(() => undefined);
    const text = lines.join("\n");
    expect(text).toContain("link_preview_fetch");
    expect(text).not.toContain(site);
    expect(text).not.toContain("秘密のタイトル");
    expect(text).not.toContain("93.184.216.34");
  });
});
