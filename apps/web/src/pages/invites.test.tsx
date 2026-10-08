import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { initialRange, linkLabel, nextQuarter, statusClass, statusText } from "../invitations/format";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

// 時計は 2026-10-10T00:00:00Z（東京は土曜 09:00）
const FRIEND_ID = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "55555555-5555-4555-8555-555555555555";
const MEETUP_ID = "66666666-6666-4666-8666-666666666666";
const friend = { id: FRIEND_ID, displayName: "あき", avatarUrl: null };
const empty = json({ items: [], nextCursor: null });
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
});
const invite = (over: Record<string, unknown> = {}) => ({
  id: INVITE_ID,
  kind: "asobo",
  direction: "received",
  counterpart: friend,
  status: "pending",
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  area: "渋谷",
  message: "ごはん\nどう？",
  url: "https://аpple.com/menu",
  expiresAt: "2026-10-10T10:00:00.000Z",
  counterProposal: null,
  meetupId: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  tokenStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("表示の関数", () => {
  it("リンクのドメインは punycode で表示し、見た目の偽装を防ぐ", () => {
    expect(linkLabel("https://аpple.com/x")).toBe("xn--pple-43d.com");
    expect(linkLabel("https://example.com/x")).toBe("example.com");
    expect(linkLabel(null)).toBeNull();
  });

  it("「みんな」の枠から誘うときの初期値：開始は次の15分の区切り以降、終了は24時間まで", () => {
    const now = Date.parse("2026-10-10T00:05:00Z");
    expect(nextQuarter(Date.parse("2026-10-10T00:15:00Z"))).toBe(Date.parse("2026-10-10T00:30:00Z"));
    // 開始が過去の「今から暇」の枠
    expect(initialRange({ startsAt: "2026-10-09T23:00:00Z", endsAt: "2026-10-10T02:00:00Z" }, now)).toEqual({
      startsAt: "2026-10-10T00:15:00.000Z",
      endsAt: "2026-10-10T02:00:00.000Z",
    });
    // まとめて24時間を超えた枠
    expect(initialRange({ startsAt: "2026-10-10T10:00:00Z", endsAt: "2026-10-11T14:00:00Z" }, now)).toEqual({
      startsAt: "2026-10-10T10:00:00.000Z",
      endsAt: "2026-10-11T10:00:00.000Z",
    });
  });

  it("状態は静かな文言で、断り・期限切れ・見送り・キャンセルに赤を使わない", () => {
    const of = (status: string, direction: "sent" | "received") =>
      statusText({ status: status as never, direction, counterProposal: null });
    expect(of("declined", "sent")).toBe("今回は難しいみたい");
    expect(of("declined", "received")).toBe("今回は難しいと返しました");
    expect(of("expired", "sent")).toBe("期限が過ぎました");
    expect(of("skipped", "sent")).toBe("見送りました");
    expect(of("skipped", "received")).toBe("見送りになりました");
    expect(of("cancelled", "received")).toBe("やっぱり難しくなりました");
    expect(of("pending", "received")).toBe("返事をしてください");
    expect(
      statusText({
        status: "counter_proposed",
        direction: "sent",
        counterProposal: { startsAt: "2026-10-10T11:00:00Z", endsAt: "2026-10-10T14:00:00Z" },
      }),
    ).toBe("この時間なら：10/10（土） 20:00〜23:00");
    for (const s of ["declined", "expired", "skipped", "cancelled", "pending"] as const) {
      expect(statusClass(s)).not.toMatch(/red|rose/);
    }
  });
});

describe("誘いの作成", () => {
  const newPage = (search: string, over: Parameters<typeof mockFetch>[0] = {}) => {
    window.history.replaceState(null, "", `/invites/new${search}`);
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/friends": json({
        items: [{ ...friend, sharesMyAvailability: true, friendsSince: "2026-10-07T00:00:00.000Z" }],
        nextCursor: null,
      }),
      "/api/v1/me/presets": presets,
      [`/api/v1/friends/${FRIEND_ID}/availabilities`]: json({
        items: [{ startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z", label: "night" }],
        nextCursor: null,
      }),
      ...over,
    });
  };

  it("「みんな」の枠から開くと、相手と時間が入り、「あそぼ」と出る。送ると詳細へ移る", async () => {
    const { calls } = newPage(
      `?friend=${FRIEND_ID}&startsAt=2026-10-10T10:00:00.000Z&endsAt=2026-10-10T14:00:00.000Z`,
      {
        "/api/v1/direct-invites": json(invite({ direction: "sent" }), 201),
        [`/api/v1/direct-invites/${INVITE_ID}`]: json(invite({ direction: "sent" })),
      },
    );
    renderApp();
    expect(await screen.findByText("あそぼ")).toBeVisible();
    expect(screen.getByLabelText("相手")).toHaveValue(FRIEND_ID);
    expect(screen.getByLabelText("開始")).toHaveValue("19:00");
    expect(screen.getByLabelText("終了")).toHaveValue("23:00");
    await userEvent.type(screen.getByLabelText("ひとこと（任意）"), "ごはん");
    await userEvent.click(screen.getByRole("button", { name: "誘う" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/invites/${INVITE_ID}`));
    const post = calls.find((c) => c.url === "/api/v1/direct-invites" && c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({
      recipientId: FRIEND_ID,
      startsAt: "2026-10-10T10:00:00.000Z",
      endsAt: "2026-10-10T14:00:00.000Z",
      area: null,
      message: "ごはん",
      url: null,
      expiresIn: "until_start",
    });
  });

  it("友達の詳細から開くと相手だけが入り、重ならない時間は「ここどう？」", async () => {
    newPage(`?friend=${FRIEND_ID}`);
    renderApp();
    expect(await screen.findByText("ここどう？")).toBeVisible();
    expect(screen.getByLabelText("相手")).toHaveValue(FRIEND_ID);
    // 初期値は1時間後の次の15分の区切りから2時間（東京 10:15〜12:15）
    expect(screen.getByLabelText("開始")).toHaveValue("10:15");
  });

  it.each([
    [429, "今日はたくさん誘ったので、少し時間をおいてください"],
    [409, "同じ時間の誘いをもう送っています"],
    [404, "この友達には送れませんでした"],
    [400, "送れませんでした。これからの時間で、15分単位、30分以上24時間以内にしてください。文字数も確かめてください"],
  ])("送れなかったとき（%i）は静かな文言を出す", async (status, text) => {
    newPage(`?friend=${FRIEND_ID}`, { "/api/v1/direct-invites": json({}, status) });
    renderApp();
    await screen.findByText("ここどう？");
    await userEvent.click(screen.getByRole("button", { name: "誘う" }));
    const message = await screen.findByText(text);
    expect(message.className).not.toMatch(/red|rose/);
  });
});

describe("誘いの詳細と返答", () => {
  const detail = (routes: Parameters<typeof mockFetch>[0]) => {
    window.history.replaceState(null, "", `/invites/${INVITE_ID}`);
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/direct-invites": empty,
      "/api/v1/meetups": empty,
      ...routes,
    });
  };

  it("内容とリンクのドメイン（punycode）を出し、「行く」で成立を表示する", async () => {
    const { calls } = detail({
      [`/api/v1/direct-invites/${INVITE_ID}`]: [json(invite()), json(invite({ status: "confirmed", meetupId: MEETUP_ID }))],
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: json(invite({ status: "confirmed", meetupId: MEETUP_ID })),
    });
    renderApp();
    expect(await screen.findByRole("heading", { name: "あそぼ" })).toBeVisible();
    expect(screen.getByText("10/10（土） 19:00〜23:00")).toBeVisible();
    expect(screen.getByRole("link", { name: "xn--pple-43d.com" })).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await userEvent.click(screen.getByRole("button", { name: "行く" }));
    expect(await screen.findByText("成立")).toBeVisible();
    expect(await screen.findByRole("link", { name: "成立した予定を見る" })).toHaveAttribute("href", `/meetups/${MEETUP_ID}`);
    const post = calls.find((c) => c.url.endsWith("/responses"));
    expect(JSON.parse(String(post?.init.body))).toEqual({ response: "accept" });
  });

  it("返答は押したらすぐ表示を変え、失敗したら戻して静かな文言を出す", async () => {
    let fail: (r: Response) => void = () => {};
    detail({
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(invite()),
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: () => new Promise<Response>((resolve) => (fail = resolve)),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "今回は難しい" }));
    expect(await screen.findByText("今回は難しいと返しました")).toBeVisible();
    expect(screen.queryByRole("button", { name: "行く" })).toBeNull();
    fail(new Response(null, { status: 503 }));
    expect(await screen.findByText("送れませんでした。もう一度お試しください")).toBeVisible();
    expect(await screen.findByRole("button", { name: "行く" })).toBeVisible();
  });

  it("この時間なら：代わりの時間を送る", async () => {
    const { calls } = detail({
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(invite()),
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: json(invite({ status: "counter_proposed" })),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "この時間なら" }));
    const start = screen.getByLabelText("開始");
    await userEvent.clear(start);
    await userEvent.type(start, "20:00");
    await userEvent.click(screen.getByRole("button", { name: "この時間で返す" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/responses"))).toBe(true));
    const post = calls.find((c) => c.url.endsWith("/responses"));
    expect(JSON.parse(String(post?.init.body))).toEqual({
      response: "counter",
      startsAt: "2026-10-10T11:00:00.000Z",
      endsAt: "2026-10-10T14:00:00.000Z",
    });
  });

  it("送信者には「この時間なら」に「決める」「見送る」を出す", async () => {
    detail({
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(
        invite({
          direction: "sent",
          status: "counter_proposed",
          counterProposal: { startsAt: "2026-10-10T11:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z" },
        }),
      ),
    });
    renderApp();
    expect(await screen.findByText("この時間なら：10/10（土） 20:00〜23:00")).toBeVisible();
    expect(screen.getByRole("button", { name: "決める" })).toBeVisible();
    expect(screen.getByRole("button", { name: "見送る" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "行く" })).toBeNull();
  });
});

describe("誘いタブと成立した予定", () => {
  it("送信の一覧に状態を静かに出す", async () => {
    window.history.replaceState(null, "", "/invites?tab=sent");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/direct-invites": json({ items: [invite({ direction: "sent", status: "declined" })], nextCursor: null }),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "送信した誘い" });
    expect(await within(list).findByText("今回は難しいみたい")).toBeVisible();
    expect(within(list).getByText("あき・あそぼ")).toBeVisible();
  });

  it("やっぱり難しい：押したらすぐキャンセルを表示する", async () => {
    window.history.replaceState(null, "", `/meetups/${MEETUP_ID}`);
    const meetup = {
      id: MEETUP_ID,
      startsAt: "2026-10-10T10:00:00.000Z",
      endsAt: "2026-10-10T14:00:00.000Z",
      status: "confirmed",
      participants: [friend],
      area: null,
      message: null,
      url: null,
      directInviteId: INVITE_ID,
      createdAt: "2026-10-10T00:00:00.000Z",
    };
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      [`/api/v1/meetups/${MEETUP_ID}`]: [json(meetup), json({ ...meetup, status: "cancelled" })],
      [`/api/v1/meetups/${MEETUP_ID}/cancel`]: json({ ...meetup, status: "cancelled" }),
      "/api/v1/meetups": empty,
      "/api/v1/direct-invites": empty,
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "やっぱり難しい" }));
    expect(await screen.findByText("やっぱり難しくなりました")).toBeVisible();
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(true);
  });
});
