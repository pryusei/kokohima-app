import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

// ブロックと通報の画面（docs/specs/T-33-block-report.md「テスト計画」）。始める日は、ここでは開いた扱いにする（vi.mock）
const safety = vi.hoisted(() => ({ open: true }));
vi.mock("../safety/open", () => ({ isSafetyOpenNow: () => safety.open }));

const FRIEND_ID = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "55555555-5555-4555-8555-555555555555";
const BROADCAST_ID = "77777777-7777-4777-8777-777777777777";
const friend = { id: FRIEND_ID, displayName: "あき", avatarUrl: null, sharesMyAvailability: true, friendsSince: "2026-10-07T00:00:00.000Z" };
const empty = json({ items: [], nextCursor: null });
const invite = {
  id: INVITE_ID,
  kind: "asobo",
  direction: "received",
  counterpart: { id: FRIEND_ID, displayName: "あき", avatarUrl: null, withdrawn: false },
  status: "pending",
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  area: null,
  message: "ごはん",
  url: null,
  linkPreview: null,
  expiresAt: "2026-10-10T10:00:00.000Z",
  counterProposal: null,
  meetupId: null,
  createdAt: "2026-10-10T00:00:00.000Z",
};

beforeEach(() => {
  safety.open = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  tokenStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function friendDetail(routes: Parameters<typeof mockFetch>[0] = {}) {
  window.history.replaceState(null, "", `/friends/${FRIEND_ID}`);
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/me": json({ id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName: "ゆう", avatarUrl: null }),
    "/api/v1/friends": empty,
    "/api/v1/invite-links": empty,
    [`/api/v1/friends/${FRIEND_ID}`]: json(friend),
    [`/api/v1/friends/${FRIEND_ID}/availabilities`]: empty,
    [`/api/v1/friends/${FRIEND_ID}/wishes`]: empty,
    ...routes,
  });
}

const bodyOf = (calls: { url: string; init: RequestInit }[], path: string) =>
  JSON.parse(String(calls.find((c) => c.url.startsWith(path) && c.init.method === "POST")?.init.body)) as Record<string, unknown>;

describe("「…」のシート（友達の詳細）", () => {
  it("軽い順に：見せる／見せない → 友達を解除 → ブロック → 通報。上に「知らせません」の1行だけ", async () => {
    friendDetail();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    const sheet = screen.getByRole("dialog", { name: "あき" });
    expect(within(sheet).getByText("どれを選んでもあきさんには知らせません。")).toBeVisible();
    const controls = [...sheet.querySelectorAll("button, [role=switch]")]
      .map((e) => (e.getAttribute("role") === "switch" ? "switch" : (e.getAttribute("aria-label") ?? e.textContent)))
      .filter((t) => t !== "閉じる");
    expect(controls).toEqual(["switch", "友達を解除", "ブロック", "通報", "戻る"]);
    expect(within(sheet).getByRole("switch", { name: "自分の暇を見せる" })).toBeChecked();
    // 「戻る」で元の中身に戻る
    await userEvent.click(within(sheet).getByRole("button", { name: "戻る" }));
    expect(await within(sheet).findByRole("link", { name: "誘う" })).toBeVisible();
  });

  it("フォーカス：開くとシートの中身（操作の領域）へ、通報に進むとその中身へ、「戻る」で「…」へ戻る", async () => {
    friendDetail();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    const region = screen.getByRole("group", { name: "あきさんへの操作" });
    await waitFor(() => expect(region).toHaveFocus());
    // 通報に進むと中身が置き換わるので、もう一度領域へ移す
    await userEvent.click(within(region).getByRole("button", { name: "通報" }));
    expect(within(region).getByRole("heading", { name: "あきさんを通報" })).toBeVisible();
    await waitFor(() => expect(region).toHaveFocus());
    await userEvent.click(within(region).getByRole("button", { name: "戻る" }));
    await userEvent.click(within(region).getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "あきさんへの操作" })).toHaveFocus());
  });

  it("ブロックは確認を1回はさみ、POST /blocks（相手の ID だけ）。静かに「ブロックしました。」→ 閉じると友達タブへ", async () => {
    const { calls } = friendDetail({ "/api/v1/blocks": () => new Response(null, { status: 204 }) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    await userEvent.click(screen.getByRole("button", { name: "ブロック" }));
    expect(screen.getByText(/友達の解除と同じになり、招待リンクでもつながらなくなります/)).toBeVisible();
    expect(calls.some((c) => c.url === "/api/v1/blocks")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "あきさんをブロックする" }));
    expect(await screen.findByText("ブロックしました。")).toBeVisible();
    expect(bodyOf(calls, "/api/v1/blocks")).toEqual({ userId: FRIEND_ID });
    await userEvent.click(screen.getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(window.location.pathname).toBe("/friends"));
  });

  it("ブロックできなかったら、静かな文言を出してシートに留まる", async () => {
    friendDetail({ "/api/v1/blocks": json({}, 500) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    await userEvent.click(screen.getByRole("button", { name: "ブロック" }));
    await userEvent.click(screen.getByRole("button", { name: "あきさんをブロックする" }));
    expect(await screen.findByText("できませんでした。もう一度お試しください。")).toBeVisible();
    expect(window.location.pathname).toBe(`/friends/${FRIEND_ID}`);
  });

  it("友達を解除も「…」から。確認は1回", async () => {
    const { calls } = friendDetail({ [`/api/v1/friends/${FRIEND_ID}`]: [json(friend), json(friend), () => new Response(null, { status: 204 })] });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    await userEvent.click(screen.getByRole("button", { name: "友達を解除" }));
    await userEvent.click(screen.getByRole("button", { name: "あきさんとの友達を解除する" }));
    expect(await screen.findByText("友達を解除しました。")).toBeVisible();
    expect(calls.some((c) => c.url === `/api/v1/friends/${FRIEND_ID}` && c.init.method === "DELETE")).toBe(true);
  });

  it("始める日より前は、ブロックと通報を出さない（見せる・解除だけ）", async () => {
    safety.open = false;
    friendDetail();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    expect(screen.getByRole("button", { name: "友達を解除" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "ブロック" })).toBeNull();
    expect(screen.queryByRole("button", { name: "通報" })).toBeNull();
  });
});

describe("通報", () => {
  function inviteDetail(routes: Parameters<typeof mockFetch>[0] = {}) {
    window.history.replaceState(null, "", `/invites/${INVITE_ID}`);
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/direct-invites": empty,
      "/api/v1/meetups": empty,
      "/api/v1/broadcasts": empty,
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(invite),
      // 友達でなくなっている（404）：見せる・解除は出さず、ブロック・通報だけ
      [`/api/v1/friends/${FRIEND_ID}`]: json({ code: "not_found" }, 404),
      ...routes,
    });
  }

  it("届いた誘いから：理由を選ぶまで送れない。「ブロックもする」は最初から印。相談先の1行。送ると対象の誘いを一緒に送る", async () => {
    const { calls } = inviteDetail({ "/api/v1/reports": () => new Response(null, { status: 204 }) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    expect(screen.queryByRole("button", { name: "友達を解除" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "通報" }));
    expect(screen.getByText("危ないと感じたら、周りの大人か #9110 へ。急ぐときは110番")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "ブロックもする" })).toBeChecked();
    const send = screen.getByRole("button", { name: "運営に送る" });
    expect(send).toBeDisabled();
    for (const label of ["何度も誘われる", "ひとこと・リンクが不快", "知らない人・なりすまし", "会うのが不安な誘い", "その他"]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
    await userEvent.click(screen.getByRole("button", { name: "会うのが不安な誘い" }));
    await userEvent.click(send);
    expect(await screen.findByText("送りました。ブロックもしました。")).toBeVisible();
    const call = calls.find((c) => c.url === "/api/v1/reports");
    expect(new Headers(call?.init.headers).get("Idempotency-Key")).toBeTruthy();
    expect(bodyOf(calls, "/api/v1/reports")).toEqual({
      userId: FRIEND_ID,
      reason: "unsafe_meetup",
      alsoBlock: true,
      subject: { type: "direct_invite", id: INVITE_ID },
    });
  });

  it("くわしくは任意で1000文字まで。超えたら送れない。印を外すとブロックしない", async () => {
    const { calls } = inviteDetail({ "/api/v1/reports": () => new Response(null, { status: 204 }) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    await userEvent.click(screen.getByRole("button", { name: "通報" }));
    await userEvent.click(screen.getByRole("button", { name: "その他" }));
    const details = screen.getByLabelText("くわしく（なくても送れます）");
    await userEvent.click(details);
    await userEvent.paste("あ".repeat(1001));
    expect(screen.getByRole("button", { name: "運営に送る" })).toBeDisabled();
    await userEvent.clear(details);
    await userEvent.type(details, "しつこい");
    await userEvent.click(screen.getByRole("checkbox", { name: "ブロックもする" }));
    await userEvent.click(screen.getByRole("button", { name: "運営に送る" }));
    expect(await screen.findByText("送りました。")).toBeVisible();
    expect(bodyOf(calls, "/api/v1/reports")).toMatchObject({ reason: "other", details: "しつこい", alsoBlock: false });
  });

  it("回数の上限（429）は静かに出し、入力は残す", async () => {
    inviteDetail({ "/api/v1/reports": json({ code: "rate_limited" }, 429) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    await userEvent.click(screen.getByRole("button", { name: "通報" }));
    await userEvent.click(screen.getByRole("button", { name: "その他" }));
    await userEvent.click(screen.getByRole("button", { name: "運営に送る" }));
    expect(await screen.findByText("今日はこれ以上送れません。ブロックは、前の画面からできます。")).toBeVisible();
    expect(screen.getByRole("button", { name: "その他" })).toHaveAttribute("aria-pressed", "true");
  });

  it("届いた募集から：募集を対象にする", async () => {
    window.history.replaceState(null, "", `/broadcasts/${BROADCAST_ID}`);
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/direct-invites": empty,
      "/api/v1/meetups": empty,
      "/api/v1/broadcasts": empty,
      [`/api/v1/broadcasts/${BROADCAST_ID}`]: json({
        id: BROADCAST_ID,
        direction: "received",
        owner: { id: FRIEND_ID, displayName: "あき", avatarUrl: null, withdrawn: false },
        status: "open",
        startsAt: "2026-10-10T10:00:00.000Z",
        endsAt: "2026-10-10T14:00:00.000Z",
        area: null,
        message: null,
        url: null,
        linkPreview: null,
        expiresAt: "2026-10-10T10:00:00.000Z",
        responseCount: null,
        respondedByMe: false,
        recipients: null,
        meetupId: null,
        createdAt: "2026-10-10T00:00:00.000Z",
      }),
      [`/api/v1/friends/${FRIEND_ID}`]: json(friend),
      "/api/v1/reports": () => new Response(null, { status: 204 }),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "あきさんへの操作" }));
    await userEvent.click(screen.getByRole("button", { name: "通報" }));
    await userEvent.click(screen.getByRole("button", { name: "何度も誘われる" }));
    await userEvent.click(screen.getByRole("button", { name: "運営に送る" }));
    expect(await screen.findByText("送りました。ブロックもしました。")).toBeVisible();
    expect(bodyOf(calls, "/api/v1/reports")).toMatchObject({ subject: { type: "broadcast", id: BROADCAST_ID } });
  });

  it("送った誘いには「…」を出さない", async () => {
    inviteDetail({ [`/api/v1/direct-invites/${INVITE_ID}`]: json({ ...invite, direction: "sent" }) });
    renderApp();
    expect(await screen.findByRole("dialog", { name: "あきさんへの誘い" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "あきさんへの操作" })).toBeNull();
  });
});

describe("設定の「ブロックした人」", () => {
  function blocked(routes: Parameters<typeof mockFetch>[0] = {}) {
    window.history.replaceState(null, "", "/settings/blocks");
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json({ id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName: "ゆう", avatarUrl: null }),
      "/api/v1/blocks": json({
        items: [{ user: { id: FRIEND_ID, displayName: "あき", avatarUrl: null, withdrawn: false }, blockedAt: "2026-10-09T00:00:00.000Z" }],
        nextCursor: null,
      }),
      ...routes,
    });
  }

  it("一覧を出し、「ブロックをやめる」で DELETE /blocks/{id}。友達には戻らないことを1行で書く", async () => {
    const { calls } = blocked({
      [`/api/v1/blocks/${FRIEND_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "ブロックした人" });
    expect(within(list).getByText("あき")).toBeVisible();
    expect(screen.getByText(/ブロックをやめても友達には戻りません/)).toBeVisible();
    await userEvent.click(within(list).getByRole("button", { name: "あきのブロックをやめる" }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/blocks/${FRIEND_ID}` && c.init.method === "DELETE")).toBe(true));
  });

  it("「ブロックをやめる」が失敗すると、閉じた行が戻り、失敗の文言が出る（行を閉じ終わってから失敗しても消えない。T-56「M-10」）", async () => {
    blocked({ [`/api/v1/blocks/${FRIEND_ID}`]: json({}, 500) });
    renderApp();
    const list = await screen.findByRole("list", { name: "ブロックした人" });
    await userEvent.click(within(list).getByRole("button", { name: "あきのブロックをやめる" }));
    expect(await screen.findByText("できませんでした。もう一度お試しください。")).toBeVisible();
    expect(within(screen.getByRole("list", { name: "ブロックした人" })).getByRole("button", { name: "あきのブロックをやめる" })).toBeVisible();
  });

  it("行の押した地は一覧の左右の端まで沈む（-mx-4 は li に付け、Collapse の中で切らない。T-56「M-11」）", async () => {
    blocked();
    renderApp();
    const list = await screen.findByRole("list", { name: "ブロックした人" });
    const item = within(list).getByRole("listitem");
    expect(item).toHaveClass("-mx-4", "kh-collapse");
    expect(item).toHaveAttribute("data-settled");
  });

  it("いなければ空の表示", async () => {
    blocked({ "/api/v1/blocks": empty });
    renderApp();
    expect(await screen.findByText("ブロックした人はいません")).toBeVisible();
  });

  it("始める日より前は、設定に行を出さず、経路は知らない経路と同じ扱い", async () => {
    safety.open = false;
    blocked({
      "/api/v1/availabilities": empty,
      "/api/v1/friends": empty,
    });
    window.history.replaceState(null, "", "/settings/blocks");
    renderApp();
    expect(await screen.findByRole("heading", { name: "みんな", level: 1 })).toBeVisible();
  });

  it("E2E の画面だけは開く（vite の define。本番のビルドと Vitest では false）", () => {
    const config = readFileSync(join(import.meta.dirname, "../../vite.config.ts"), "utf8");
    expect(config).toContain('__SAFETY_FORCE_OPEN__: JSON.stringify(process.env.E2E === "1")');
    expect(__SAFETY_FORCE_OPEN__).toBe(false);
  });
});

describe("招待リンクの受け口", () => {
  it("ログインしていれば、lookup にアクセストークンを付ける（ブロックがあれば使えないリンクと同じ表示）", async () => {
    window.history.replaceState(null, "", "/invite#t=secret-invite-token");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody("access-9")),
      "/api/v1/invite-links/lookup": json({ code: "not_found" }, 404),
    });
    renderApp();
    expect(await screen.findByText("このリンクは使えません。発行した人に新しいリンクをもらってください。")).toBeVisible();
    const lookup = calls.find((c) => c.url === "/api/v1/invite-links/lookup");
    expect(new Headers(lookup?.init.headers).get("Authorization")).toBe("Bearer access-9");
    expect(window.location.hash).toBe("");
  });
});
