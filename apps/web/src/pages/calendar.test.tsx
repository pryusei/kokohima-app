import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { redirectTo } from "./CalendarSettingsPage";

// カレンダー連携の画面（docs/specs/T-06-calendar.md「画面」）。時計は 2026-10-10T00:00:00Z（東京は土曜 09:00）

const MEETUP_ID = "55555555-5555-4555-8555-555555555555";
const none = json({ google: { status: "none", connectedAt: null } });
const connected = json({ google: { status: "connected", connectedAt: "2026-10-01T00:00:00.000Z" } });
const empty = json({ items: [], nextCursor: null });
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
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

describe("設定のカレンダー連携", () => {
  it("連携していなければ「連携していません」。連携を押すと authorizeUrl へ画面遷移する", async () => {
    window.history.replaceState(null, "", "/settings/calendar");
    const go = vi.spyOn(redirectTo, "go").mockImplementation(() => {});
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/calendar/connections": none,
      "/api/v1/calendar/google/authorizations": json({ authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }),
    });
    renderApp();
    expect(await screen.findByText("連携していません")).toBeVisible();
    expect(screen.getByText(/予定のタイトル・場所・参加者は読みません/)).toBeVisible();
    expect(screen.getByText("Appleカレンダーとの連携は準備中です。成立した予定は、予定の画面の「カレンダーに追加」から入れられます")).toBeVisible();
    expect(screen.getByText(/成立した予定は、予定の画面から自分で追加できます/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "連携をやめる" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Googleカレンダーと連携" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
    expect(calls.find((c) => c.url === "/api/v1/calendar/google/authorizations")?.init.method).toBe("POST");
  });

  it("連携中なら「連携中」。やめると読み直して「連携していません」", async () => {
    window.history.replaceState(null, "", "/settings/calendar");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/calendar/connections": [connected, none],
      "/api/v1/calendar/connections/google": () => new Response(null, { status: 204 }),
    });
    renderApp();
    expect(await screen.findByText("連携中")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Googleカレンダーと連携" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "連携をやめる" }));
    expect(await screen.findByText("連携していません")).toBeVisible();
    expect(calls.find((c) => c.url === "/api/v1/calendar/connections/google")?.init.method).toBe("DELETE");
  });

  it("戻ってきた ?calendar= を静かに出す。needs_reauth は「もう一度連携してください」", async () => {
    window.history.replaceState(null, "", "/settings/calendar?calendar=failed");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/calendar/connections": json({ google: { status: "needs_reauth", connectedAt: "2026-10-01T00:00:00.000Z" } }),
    });
    renderApp();
    // 結果の帯に出し、本文の流れには置かない（docs/specs/T-56-motion.md「M-09」）
    const band = screen.getByTestId("result-band");
    expect(await within(band).findByText("連携できませんでした。もう一度お試しください")).toBeVisible();
    expect(band.innerHTML).not.toMatch(/red|rose/);
    expect(within(screen.getByRole("main")).queryByText("連携できませんでした。もう一度お試しください")).toBeNull();
    expect(await screen.findByText("もう一度連携してください")).toBeVisible();
    expect(screen.getByRole("button", { name: "Googleカレンダーと連携" })).toBeVisible();
    expect(screen.getByRole("button", { name: "連携をやめる" })).toBeVisible();
  });

  it("?calendar=connected は「連携しました」", async () => {
    window.history.replaceState(null, "", "/settings/calendar?calendar=connected");
    mockFetch({ "/api/v1/auth/refresh": json(tokenBody()), "/api/v1/calendar/connections": connected });
    renderApp();
    expect(await within(screen.getByTestId("result-band")).findByText("連携しました")).toBeVisible();
    expect(screen.getAllByText("連携しました")).toHaveLength(1);
  });
});

describe("ここ暇タブの週の帯の「カレンダーで空き」の点（docs/specs/T-55-availability-week-grid.md）", () => {
  const tab = (over: Record<string, Parameters<typeof mockFetch>[0][string]>) => {
    window.history.replaceState(null, "", "/availability");
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me/presets": presets,
      "/api/v1/availabilities": empty,
      "/api/v1/recurrence-rules": empty,
      ...over,
    });
  };
  const cell = (prefix: string) => screen.findByRole("button", { name: (name) => name.startsWith(`${prefix} `) });
  const slot = (date: string, preset: "day" | "evening" | "night", start: string, end: string) => ({
    date,
    preset,
    startsAt: `${date}T${start}:00:00.000Z`,
    endsAt: `${date}T${end}:00:00.000Z`,
  });

  it("連携していなければ点も凡例も出さず、候補も読まない（マスの見た目は同じ）", async () => {
    const { calls } = tab({ "/api/v1/calendar/connections": none });
    renderApp();
    await screen.findByRole("heading", { name: /^自分のここ暇/ });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/calendar/connections")).toBe(true));
    expect(screen.queryByText("カレンダーで空き")).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/api/v1/calendar/free-slots"))).toBe(false);
  });

  it("空いているマスに点。名前に「カレンダーで空き」。今日から14日分を読み、次の7日にも出す", async () => {
    const { calls } = tab({
      "/api/v1/calendar/connections": connected,
      "/api/v1/calendar/free-slots": json({
        status: "ok",
        items: [slot("2026-10-10", "night", "10", "14"), slot("2026-10-12", "day", "02", "06"), slot("2026-10-19", "evening", "07", "10")],
        nextCursor: null,
      }),
    });
    renderApp();
    const night = await cell("10/10（土） 夜");
    await waitFor(() => expect(night).toHaveAccessibleName("10/10（土） 夜 19:00〜23:00 カレンダーで空き。押すとここ暇にする"));
    expect((await cell("10/12（月） 昼")).getAttribute("aria-label")).toContain("カレンダーで空き");
    expect((await cell("10/12（月） 夕方")).getAttribute("aria-label")).not.toContain("カレンダーで空き");
    expect(screen.getByText("カレンダーで空き")).toBeInTheDocument();
    // 予定の中身（タイトル・場所・参加者）は受け取らないので、出しようがない。点は見た目の印だけ
    expect(night.querySelector(".bg-meet")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "次の7日 ›" }));
    expect((await cell("10/19（月） 夕方")).getAttribute("aria-label")).toContain("カレンダーで空き");
    const url = new URL(calls.find((c) => c.url.startsWith("/api/v1/calendar/free-slots"))?.url ?? "", "http://x");
    expect(url.searchParams.get("from")).toBe("2026-10-09T15:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-10-23T15:00:00.000Z");
  });

  it("点のマスを押すと、その日付とプリセットでここ暇を作る", async () => {
    const created = {
      source: "manual",
      id: "33333333-3333-4333-8333-333333333333",
      date: null,
      startsAt: "2026-10-10T10:00:00.000Z",
      endsAt: "2026-10-10T14:00:00.000Z",
      label: "night",
    };
    const { calls } = tab({
      "/api/v1/calendar/connections": connected,
      "/api/v1/calendar/free-slots": json({ status: "ok", items: [slot("2026-10-10", "night", "10", "14")], nextCursor: null }),
      "/api/v1/availabilities": ({ init }) => (init.method === "POST" ? json(created, 201)() : empty()),
    });
    renderApp();
    const night = await cell("10/10（土） 夜");
    await waitFor(() => expect(night.getAttribute("aria-label")).toContain("カレンダーで空き"));
    await userEvent.click(night);
    const post = await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/v1/availabilities" && x.init.method === "POST");
      if (!c) throw new Error("not yet");
      return c;
    });
    expect(JSON.parse(String(post.init.body))).toEqual({ date: "2026-10-10", preset: "night" });
  });

  it("unavailable は「カレンダーを読み込めませんでした」を静かに出す", async () => {
    tab({
      "/api/v1/calendar/connections": connected,
      "/api/v1/calendar/free-slots": json({ status: "unavailable", items: [], nextCursor: null }),
    });
    renderApp();
    const text = await screen.findByText("カレンダーを読み込めませんでした");
    expect(text.className).not.toMatch(/red|rose/);
  });

  it("回数の上限（429）は点を出さず、静かに待ってもらう。取り直さない", async () => {
    const { calls } = tab({
      "/api/v1/calendar/connections": connected,
      "/api/v1/calendar/free-slots": json({ type: "about:blank", title: "x", status: 429, code: "rate_limited", requestId: "r" }, 429),
    });
    renderApp();
    const text = await screen.findByText("カレンダーの空きは、少し待ってからもう一度開くと出ます");
    expect(text.className).not.toMatch(/red|rose/);
    expect(calls.filter((c) => c.url.startsWith("/api/v1/calendar/free-slots"))).toHaveLength(1);
  });

  it("needs_reauth は設定へのリンクを出す", async () => {
    tab({ "/api/v1/calendar/connections": json({ google: { status: "needs_reauth", connectedAt: null } }) });
    renderApp();
    expect(await screen.findByRole("link", { name: "設定" })).toHaveAttribute("href", "/settings/calendar");
  });
});

describe("予定の詳細の .ics", () => {
  it("押すと一時的な URL を発行し、その URL へ画面遷移する", async () => {
    window.history.replaceState(null, "", `/meetups/${MEETUP_ID}`);
    const go = vi.spyOn(redirectTo, "go").mockImplementation(() => {});
    const meetup = {
      id: MEETUP_ID,
      startsAt: "2026-10-11T10:00:00.000Z",
      endsAt: "2026-10-11T14:00:00.000Z",
      status: "confirmed",
      participants: [{ id: "22222222-2222-4222-8222-222222222222", displayName: "あき", avatarUrl: null, withdrawn: false }],
      area: null,
      message: null,
      url: null,
      linkPreview: null,
      directInviteId: null,
      broadcastId: null,
      createdAt: "2026-10-10T00:00:00.000Z",
    };
    const link = `https://app.test/api/v1/ics/${"a".repeat(43)}`;
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup),
      [`/api/v1/meetups/${MEETUP_ID}/ics-links`]: json({ url: link, expiresAt: "2026-10-10T00:05:00.000Z" }),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "カレンダーに追加" }));
    await userEvent.click(screen.getByRole("button", { name: "ほかのカレンダーに追加" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(link));
    expect(calls.find((c) => c.url.endsWith("/ics-links"))?.init.method).toBe("POST");
  });
});

describe("予定の詳細の .ics の上限", () => {
  it("回数の上限（429）は「少し待ってから」を静かに出す", async () => {
    window.history.replaceState(null, "", `/meetups/${MEETUP_ID}`);
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      [`/api/v1/meetups/${MEETUP_ID}`]: json({
        id: MEETUP_ID,
        startsAt: "2026-10-11T10:00:00.000Z",
        endsAt: "2026-10-11T14:00:00.000Z",
        status: "confirmed",
        participants: [{ id: "22222222-2222-4222-8222-222222222222", displayName: "あき", avatarUrl: null, withdrawn: false }],
        area: null,
        message: null,
        url: null,
        linkPreview: null,
        directInviteId: null,
        broadcastId: null,
        createdAt: "2026-10-10T00:00:00.000Z",
      }),
      [`/api/v1/meetups/${MEETUP_ID}/ics-links`]: json({ type: "about:blank", title: "x", status: 429, code: "rate_limited", requestId: "r" }, 429),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "カレンダーに追加" }));
    await userEvent.click(screen.getByRole("button", { name: "ほかのカレンダーに追加" }));
    const text = await screen.findByText("少し待ってから、もう一度お試しください");
    expect(text.className).not.toMatch(/red|rose/);
  });
});
