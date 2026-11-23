import { env } from "cloudflare:workers";
import { wishSuggestionQuotaSchema, wishSuggestionResultSchema } from "@kokohima/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidate, SHOP_A, SHOP_B } from "../../test/fake-claude";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { cleanupExpired } from "../jobs/dispatch";
import {
  acceptCandidates,
  admission,
  localDayBounds,
  looseUrlKey,
  normalizeUrl,
  readSuggestConfig,
  remaining,
  retryAfterSeconds,
  reviewCandidates,
  SUGGEST_DEFAULTS,
  SYSTEM_PROMPT,
} from "./domain/suggestion";
import { webSearchTool } from "./infra/claude";

// 行きたいのAI提案（docs/specs/T-29-wish-suggestion.md「テスト計画」）。時計は 2026-10-10T00:00:00Z（日本時間の 09:00）

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type SseEvent = { event: string; data: unknown };

/** ストリームの本文を読み切って、イベントの並びにする（コメントの行は捨てる） */
async function events(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").filter((l) => l !== "" && !l.startsWith(":")))
    .filter((lines) => lines.length > 0)
    .map((lines) => ({
      event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "",
      data: JSON.parse(lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "null") as unknown,
    }));
}

const suggest = (who: User, body: Record<string, unknown> = {}, init: { signal?: AbortSignal } = {}) => {
  const headers: Record<string, string> = { Authorization: `Bearer ${who.token}`, "Content-Type": "application/json", Origin: "https://app.test" };
  return h.request("/api/v1/wish-suggestions", {
    method: "POST",
    headers,
    body: JSON.stringify({ area: "渋谷", query: "ラーメン", ...body }),
    signal: init.signal,
  });
};

async function resultOf(res: Response) {
  expect(res.status).toBe(200);
  const list = await events(res);
  const last = list.at(-1);
  expect(last?.event).toBe("result");
  return { list, result: wishSuggestionResultSchema.parse(last?.data) };
}

const quota = async (who: User) =>
  wishSuggestionQuotaSchema.parse(await (await u.call("GET", "/api/v1/wish-suggestions/quota", { token: who.token })).json());

const attempts = async (userId: string) =>
  (
    await env.DB.prepare("SELECT * FROM wish_suggestion_attempts WHERE user_id = ?1 ORDER BY created_at").bind(userId).all<Record<string, unknown>>()
  ).results;

const empty = () => ({ results: [SHOP_A], output: { candidates: [] } });

describe("domain", () => {
  const config = readSuggestConfig({ ANTHROPIC_API_KEY: "k" })!;

  it("設定値：キーがなければ止める。上限は省略すると既定、正の整数でなければ止める。モデルの既定は Haiku 5.5", () => {
    expect(config).toEqual({ apiKey: "k", ...SUGGEST_DEFAULTS });
    expect(config.model).toBe("claude-haiku-5-5");
    expect(readSuggestConfig({})).toBeNull();
    expect(readSuggestConfig({ ANTHROPIC_API_KEY: " " })).toBeNull();
    expect(readSuggestConfig({ ANTHROPIC_API_KEY: "k", WISH_SUGGEST_USER_DAILY_LIMIT: "0" })).toBeNull();
    expect(readSuggestConfig({ ANTHROPIC_API_KEY: "k", WISH_SUGGEST_GLOBAL_DAILY_LIMIT: "abc" })).toBeNull();
    expect(readSuggestConfig({ ANTHROPIC_API_KEY: "k", WISH_SUGGEST_MODEL: "claude-sonnet-5-5" })?.model).toBe("claude-sonnet-5-5");
  });

  it("URL の正規化：ホストを小文字、末尾の / と # 以降を外す。http・https 以外は null", () => {
    expect(normalizeUrl("https://SHOP.example/a/#menu")).toBe("https://shop.example/a");
    expect(normalizeUrl("https://shop.example/")).toBe("https://shop.example");
    expect(normalizeUrl("https://shop.example/a?x=1")).toBe("https://shop.example/a?x=1");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("候補の検査：検索の結果にない URL・URL の重複を捨て、先頭3件まで", () => {
    const urls = ["https://a.example/1", "https://a.example/2/", "https://A.example/3", "https://a.example/4"];
    const out = acceptCandidates(
      {
        candidates: [
          candidate("https://a.example/1"),
          candidate("https://made-up.example/"),
          candidate("https://a.example/1#again"),
          candidate("https://a.example/2", { reason: "あ".repeat(41) }),
          candidate("https://a.example/2"),
          candidate("https://a.example/3"),
          candidate("https://a.example/4"),
        ],
      },
      urls,
    );
    // 長い理由は切って残し、URL は検索の結果の方（末尾の / つき）に差し替える。ホストは linkUrlSchema で小文字になる
    expect(out.map((c) => c.url)).toEqual(["https://a.example/1", "https://a.example/2/", "https://a.example/3"]);
    expect(out[1]?.reason.endsWith("…")).toBe(true);
    expect(acceptCandidates({ candidates: [] }, urls)).toEqual([]);
    expect(acceptCandidates("nope", urls)).toEqual([]);
    expect(acceptCandidates({ candidates: [candidate("https://a.example/1")] }, [])).toEqual([]);
  });

  it("ゆるい突き合わせ：www.・http/https・? 以降・末尾の / の違いは同じページとし、検索の結果の URL に差し替える", () => {
    expect(looseUrlKey("http://www.Shop.example/a/?x=1#m")).toBe("shop.example/a");
    expect(looseUrlKey("https://shop.example/a")).toBe("shop.example/a");
    expect(looseUrlKey("ftp://shop.example/a")).toBeNull();
    const urls = ["https://www.shop.example/a?ref=search", "https://shop.example/b"];
    const r = reviewCandidates(
      { candidates: [candidate("http://shop.example/a/"), candidate("https://www.shop.example/b?utm=1")] },
      urls,
    );
    expect(r.accepted.map((c) => c.url)).toEqual(["https://www.shop.example/a?ref=search", "https://shop.example/b"]);
    expect(r.dropped.notInResults).toBe(0);
  });

  it("差し替えに使う検索の結果の URL も linkUrlSchema を通す（認証情報入り・制御文字入りの結果は使わない）", () => {
    const bad = ["https://user:pass@shop.example/a", "https://shop.example/b\u0007", `https://shop.example/${"x".repeat(2100)}`];
    const r = reviewCandidates(
      { candidates: [candidate("https://shop.example/a"), candidate("https://shop.example/b"), candidate("https://shop.example/x")] },
      bad,
    );
    expect(r.accepted).toEqual([]);
    expect(r.dropped.notInResults).toBe(3);
  });

  it("ゆるいキーが検索の結果の2つ以上に当たるときは、どれか決められないので捨てる。ちょうど一致するならそのまま", () => {
    const urls = ["https://shop.example/a?id=1", "https://shop.example/a?id=2"];
    expect(reviewCandidates({ candidates: [candidate("https://shop.example/a")] }, urls).dropped.notInResults).toBe(1);
    expect(reviewCandidates({ candidates: [candidate("https://shop.example/a?id=2")] }, urls).accepted[0]?.url).toBe(
      "https://shop.example/a?id=2",
    );
  });

  it("店の名前・理由・エリアが長ければ切って「…」を付ける（捨てない）。ひとことは切らない", () => {
    const urls = ["https://shop.example/a"];
    const long = reviewCandidates(
      { candidates: [candidate(urls[0]!, { placeName: "名".repeat(50), reason: "理".repeat(60), area: "駅".repeat(40) })] },
      urls,
    );
    expect(long.accepted).toHaveLength(1);
    expect(Array.from(long.accepted[0]!.placeName)).toHaveLength(40);
    expect(long.accepted[0]!.reason.endsWith("…")).toBe(true);
    expect(Array.from(long.accepted[0]!.reason)).toHaveLength(40);
    expect(Array.from(long.accepted[0]!.area ?? "")).toHaveLength(30);
    expect(reviewCandidates({ candidates: [candidate(urls[0]!, { message: "あ".repeat(101) })] }, urls).dropped.invalid).toBe(1);
  });

  it("エリアは空なら null（置くシートには探したときのエリア）", () => {
    const urls = ["https://shop.example/a"];
    expect(reviewCandidates({ candidates: [candidate(urls[0]!, { area: "" })] }, urls).accepted[0]?.area).toBeNull();
    expect(reviewCandidates({ candidates: [candidate(urls[0]!, { area: "代官山" })] }, urls).accepted[0]?.area).toBe("代官山");
  });

  it("捨てた候補を理由ごとに数える（検索の結果にない・形が違う・重複・4件め以降）", () => {
    const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"];
    const r = reviewCandidates(
      {
        candidates: [
          candidate("https://a.example/1"),
          candidate("https://made-up.example/"),
          candidate("https://made-up.example/2"),
          candidate("https://a.example/2", { reason: "" }),
          candidate("https://a.example/1"),
          candidate("https://a.example/2"),
          candidate("https://a.example/3"),
          candidate("https://a.example/4"),
        ],
      },
      urls,
    );
    expect(r.accepted).toHaveLength(3);
    expect(r.dropped).toEqual({ notInResults: 2, invalid: 1, duplicate: 1, overLimit: 1 });
    expect(reviewCandidates(null, urls).dropped).toEqual({ notInResults: 0, invalid: 0, duplicate: 0, overLimit: 0 });
  });

  it("Web検索のツールは、Haiku なら古い版、それ以外は新しい版（絞り込みつき）", () => {
    expect(webSearchTool("claude-haiku-5-5")).toMatchObject({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
    expect(webSearchTool("claude-sonnet-5-5")).toMatchObject({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
    expect(webSearchTool("claude-opus-5-5").type).toBe("web_search_20260209");
  });

  it("system は URL の書き写し・ひとことの長さと例・理由を別の情報にすることを頼む（動く値を入れない）", () => {
    expect(SYSTEM_PROMPT).toContain("一字一句そのまま書き写して");
    expect(SYSTEM_PROMPT).toContain("20文字以内");
    expect(SYSTEM_PROMPT).toContain("代官山の鉄板焼き花行きたい");
    expect(SYSTEM_PROMPT).toContain("message とは違う情報");
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("日本時間の今日の始まりと次の日、Retry-After", () => {
    const now = Date.parse("2026-10-10T00:00:00Z");
    expect(localDayBounds(now, "Asia/Tokyo")).toEqual({
      start: Date.parse("2026-10-09T15:00:00Z"),
      end: Date.parse("2026-10-10T15:00:00Z"),
    });
    expect(localDayBounds(Date.parse("2026-10-10T14:59:59Z"), "Asia/Tokyo").end).toBe(Date.parse("2026-10-10T15:00:00Z"));
    expect(localDayBounds(Date.parse("2026-10-10T15:00:00Z"), "Asia/Tokyo").start).toBe(Date.parse("2026-10-10T15:00:00Z"));
    expect(retryAfterSeconds(now, Date.parse("2026-10-10T15:00:00Z"))).toBe(15 * 3600);
    expect(retryAfterSeconds(now, now)).toBe(1);
  });

  it("判定の順番は 終わっていない回 → 1人の上限 → 全体の上限。残りは探せる回数と試せる回数の小さい方", () => {
    const base = { inFlight: false, found: 0, attempts: 0, global: 0 };
    expect(admission(base, config).kind).toBe("ok");
    expect(admission({ ...base, inFlight: true, found: 5 }, config).kind).toBe("in_flight");
    expect(admission({ ...base, found: 5 }, config).kind).toBe("user_limited");
    expect(admission({ ...base, attempts: 10 }, config).kind).toBe("user_limited");
    expect(admission({ ...base, global: 100 }, config).kind).toBe("global_limited");
    expect(remaining({ found: 2, attempts: 3 }, config)).toBe(3);
    expect(remaining({ found: 1, attempts: 8 }, config)).toBe(2);
    expect(remaining({ found: 5, attempts: 12 }, config)).toBe(0);
  });
});

describe("探す（POST /wish-suggestions）", () => {
  it("進み具合（searching → choosing）と、検査した3件の result が順に届き、記録は found になる", async () => {
    const a = await u.user("あき");
    const res = await suggest(a);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { list, result } = await resultOf(res);
    expect(list.map((e) => e.event)).toEqual(["progress", "progress", "result"]);
    expect(list.slice(0, 2).map((e) => e.data)).toEqual([{ stage: "searching" }, { stage: "choosing" }]);
    // 検索の結果にない URL（made-up）は捨て、正規化で一致したもの（末尾の /・大文字のホスト・#）は残す
    expect(result.candidates.map((c) => c.placeName)).toEqual(["麺処こもれび", "らーめん灯", "夜鳴きそば ほしの"]);
    expect(result.candidates[0]).toEqual({ ...candidate(SHOP_A.url), area: null });
    const rows = await attempts(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "found" });
    // 入力の言葉・候補は D1 に書かない（列がない）
    expect(Object.keys(rows[0]!).sort()).toEqual(["created_at", "finished_at", "id", "outcome", "user_id"]);
  });

  it("Claude に渡すのはエリアと言葉と固定の system だけ。利用者の ID・名前・友達は入らない。モデル・ツール・上限は決めたとおり", async () => {
    const a = await u.user("あき");
    const friend = await u.user("ともだちのはる");
    await u.befriend(a, friend);
    await resultOf(await suggest(a, { area: "鎌倉", query: "海の見えるカフェ" }));
    const req = h.claude.state.requests[0]!;
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    // SDK（1.x）は API キーを Authorization の Bearer で送る
    expect(req.headers.get("authorization")).toBe("Bearer sk-ant-test");
    expect(req.json).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 4000,
      stream: true,
      messages: [{ role: "user", content: "エリア：鎌倉\nしたいこと：海の見えるカフェ" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3, user_location: { type: "approximate", country: "JP" } }],
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(req.json).not.toHaveProperty("thinking");
    const sent = JSON.stringify(req.json);
    expect(sent).not.toContain(a.id);
    expect(sent).not.toContain("あき");
    expect(sent).not.toContain(friend.id);
    expect(sent).not.toContain("ともだちのはる");
  });

  it("モデルは設定値（WISH_SUGGEST_MODEL）のものを使う", async () => {
    h.bindings.WISH_SUGGEST_MODEL = "claude-sonnet-5-5";
    const a = await u.user();
    await resultOf(await suggest(a));
    expect(h.claude.state.requests[0]?.json.model).toBe("claude-sonnet-5-5");
    expect(h.claude.state.requests[0]?.json.tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 3, user_location: { type: "approximate", country: "JP" } },
    ]);
  });

  it("入力が不正なら400（ストリームにならない）。数えない", async () => {
    const a = await u.user();
    for (const body of [
      { area: "" },
      { area: "あ".repeat(31) },
      { area: "渋\n谷" },
      { area: "渋\u0007谷" },
      { query: "  " },
      { query: "あ".repeat(61) },
      { query: "a\nb" },
      { query: "ラー\u202eメン" },
      { area: "渋谷", query: "x", extra: 1 },
    ]) {
      const res = await suggest(a, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    }
    expect(await attempts(a.id)).toHaveLength(0);
    expect(h.claude.state.requests).toHaveLength(0);
  });

  it("認証がなければ401", async () => {
    const res = await h.request("/api/v1/wish-suggestions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("0件なら empty。探せる回数に数えず、試せる回数に数える", async () => {
    const a = await u.user();
    h.claude.state.next.push(empty());
    expect((await resultOf(await suggest(a))).result.candidates).toEqual([]);
    expect((await attempts(a.id))[0]).toMatchObject({ outcome: "empty" });
    // 探せる回数は5のまま、試せる回数は残り9
    expect(await quota(a)).toEqual({ remaining: 5, limit: 5 });
    for (let i = 0; i < 5; i++) h.claude.state.next.push(empty());
    for (let i = 0; i < 5; i++) await resultOf(await suggest(a));
    expect(await quota(a)).toEqual({ remaining: 4, limit: 5 });
  });

  it.each([
    ["500", { status: 500 }, "api_error"],
    ["429", { status: 429 }, "api_error"],
    ["refusal", { results: [SHOP_A], output: "", stopReason: "refusal" as const }, "refusal"],
    ["形が違う応答", { results: [SHOP_A], output: "これは JSON ではありません" }, "bad_output"],
    ["途中で切れた", { results: [SHOP_A], output: '{"candidates":[', stopReason: "max_tokens" as const }, "incomplete"],
    ["時間切れ", "hang" as const, "timeout"],
  ])("失敗（%s）は candidates: [] の result で閉じ、記録は failed", async (_name, next, reason) => {
    const a = await u.user();
    const log = vi.spyOn(console, "log");
    h.claude.state.next.push(next);
    const { list, result } = await resultOf(await suggest(a));
    expect(result.candidates).toEqual([]);
    expect(list.at(-1)?.event).toBe("result");
    expect((await attempts(a.id))[0]).toMatchObject({ outcome: "failed" });
    const call = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("wish_suggest_call"));
    expect(JSON.parse(call ?? "{}")).toMatchObject({ event: "wish_suggest_call", outcome: "failed", reason });
    // 探せる回数には数えない
    expect((await quota(a)).remaining).toBe(5);
  });

  it("画面を閉じた（通信が切れた）ら Claude の呼び出しも止め、記録は failed", async () => {
    const a = await u.user();
    h.claude.state.next.push("hang");
    const controller = new AbortController();
    const res = await suggest(a, {}, { signal: controller.signal });
    expect(res.status).toBe(200);
    controller.abort();
    await res.text().catch(() => "");
    await vi.waitFor(async () => expect((await attempts(a.id))[0]).toMatchObject({ outcome: "failed" }), { timeout: 2000 });
  });

  it("ログに入力の言葉・候補・URL を出さない", async () => {
    const a = await u.user();
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    await resultOf(await suggest(a, { area: "下北沢", query: "古着とカレー" }));
    const all = lines.join("\n");
    expect(all).toContain("wish_suggest_call");
    // 捨てた数（既定の答えは、検索の結果にない URL が1件）とモデルとキャッシュのトークン数は出す
    const call = JSON.parse(lines.find((l) => l.includes("wish_suggest_call")) ?? "{}") as Record<string, unknown>;
    expect(call).toMatchObject({
      model: "claude-haiku-5-5",
      candidates: 3,
      dropped: { notInResults: 1, invalid: 0, duplicate: 0, overLimit: 0 },
    });
    expect(call).toHaveProperty("cacheReadTokens");
    expect(call).toHaveProperty("cacheWriteTokens");
    for (const secret of ["下北沢", "古着とカレー", "shop.example", "こもれび", "sk-ant-test"]) expect(all).not.toContain(secret);
  });
});

describe("回数の上限", () => {
  it("探せる回数の5回めは通り、6回めは429。Retry-After は日本時間の次の日まで", async () => {
    const a = await u.user();
    for (let i = 0; i < 5; i++) await resultOf(await suggest(a));
    expect(await quota(a)).toEqual({ remaining: 0, limit: 5 });
    const res = await suggest(a);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(15 * 3600));
    expect(h.claude.state.requests).toHaveLength(5);
    // 日本時間の次の日になれば、また探せる
    await u.advance(15 * HOUR, a);
    expect((await quota(a)).remaining).toBe(5);
    await resultOf(await suggest(a));
  });

  it("試せる回数（0件・失敗も含む）の11回めは429", async () => {
    const a = await u.user();
    for (let i = 0; i < 10; i++) h.claude.state.next.push(i % 2 === 0 ? empty() : { status: 500 });
    for (let i = 0; i < 10; i++) await resultOf(await suggest(a));
    expect((await quota(a)).remaining).toBe(0);
    expect((await suggest(a)).status).toBe(429);
  });

  it("サービス全体の上限で503（0件・失敗も数える）。ほかの人には429ではなく503", async () => {
    // 同じ D1 にほかのテストの行があるので、今の数から2回だけ通す
    const today = Date.parse("2026-10-10T00:00:00Z");
    const before =
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM wish_suggestion_attempts WHERE created_at >= ?1").bind(today).first<{ n: number }>())?.n ?? 0;
    h.bindings.WISH_SUGGEST_GLOBAL_DAILY_LIMIT = String(before + 2);
    const a = await u.user("あき");
    const b = await u.user("はる");
    const log = vi.spyOn(console, "log");
    h.claude.state.next.push(empty());
    await resultOf(await suggest(a));
    await resultOf(await suggest(b));
    const res = await suggest(b);
    expect(res.status).toBe(503);
    expect(log.mock.calls.some((c) => String(c[0]).includes("wish_suggest_global_limit"))).toBe(true);
  });

  it("同じ人が探している間の2つめは409。90秒を過ぎた pending は探せる回数に数えない", async () => {
    const a = await u.user();
    await env.DB.prepare("INSERT INTO wish_suggestion_attempts (id, user_id, outcome, created_at) VALUES (?1, ?2, 'pending', ?3)")
      .bind(crypto.randomUUID(), a.id, h.clock.now - 10 * SEC)
      .run();
    expect((await suggest(a)).status).toBe(409);
    expect(await quota(a)).toEqual({ remaining: 4, limit: 5 });
    h.clock.now += 90 * SEC;
    // 窓を過ぎた pending は探せる回数に数えず、試せる回数に数える（残り：探せる5・試せる9）
    expect(await quota(a)).toEqual({ remaining: 5, limit: 5 });
    await resultOf(await suggest(a));
  });

  it("他人の行は数えない（quota と上限は閲覧者の行だけ）", async () => {
    const a = await u.user("あき");
    const b = await u.user("はる");
    for (let i = 0; i < 5; i++) await resultOf(await suggest(a));
    expect((await suggest(a)).status).toBe(429);
    expect(await quota(b)).toEqual({ remaining: 5, limit: 5 });
    await resultOf(await suggest(b));
  });

  it("設定値（キー）がなければ POST は503、quota は limit 0", async () => {
    h.bindings.ANTHROPIC_API_KEY = "";
    const a = await u.user();
    expect((await suggest(a)).status).toBe(503);
    expect(await quota(a)).toEqual({ remaining: 0, limit: 0 });
    expect(await attempts(a.id)).toHaveLength(0);
  });
});

describe("掃除と退会", () => {
  it("UTC で3日前の日付より前の行を毎分の掃除で消す", async () => {
    const a = await u.user();
    await resultOf(await suggest(a));
    h.clock.now += 3 * DAY;
    await cleanupExpired(h.ctx);
    expect(await attempts(a.id)).toHaveLength(1);
    h.clock.now += DAY;
    await cleanupExpired(h.ctx);
    expect(await attempts(a.id)).toHaveLength(0);
  });

  it("退会で本人とのつながりを切る（行は消さず、全体の1日の数は減らない）。退会してログインし直しても、全体の上限は戻らない", async () => {
    const today = Date.parse("2026-10-10T00:00:00Z");
    const totalToday = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM wish_suggestion_attempts WHERE created_at >= ?1").bind(today).first<{ n: number }>())
        ?.n ?? 0;
    const a = await u.user();
    const b = await u.user();
    await resultOf(await suggest(a));
    await resultOf(await suggest(b));
    const before = await totalToday();
    h.bindings.WISH_SUGGEST_GLOBAL_DAILY_LIMIT = String(before + 1);
    const res = await u.call("POST", "/api/v1/me/withdrawal", {
      token: a.token,
      body: { confirm: "withdraw" },
      cookie: `__Host-kh_rt=${a.refreshToken}`,
    });
    expect(res.status).toBe(204);
    expect(await attempts(a.id)).toHaveLength(0);
    expect(await attempts(b.id)).toHaveLength(1);
    expect(await totalToday()).toBe(before);
    // 退会のあとの新しい利用者は、残り1回だけ通り、その次は全体の上限で503
    const c = await u.user();
    await resultOf(await suggest(c));
    expect((await suggest(c)).status).toBe(503);
  });

  it("退会したあとのアクセストークンでは探せない", async () => {
    const a = await u.user();
    await u.call("POST", "/api/v1/me/withdrawal", { token: a.token, body: { confirm: "withdraw" }, cookie: `__Host-kh_rt=${a.refreshToken}` });
    expect((await suggest(a)).status).toBe(401);
  });
});

void SHOP_B;
