import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "../api/keys";
import { tokenStore } from "../auth/tokenStore";
import { markMeetMomentSeen } from "../invitations/meetMomentSeen";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { redirectTo } from "./CalendarSettingsPage";

// 成立した予定の Google カレンダーの欄（docs/specs/T-57-meetup-google-calendar.md）。時計は 2026-10-10T00:00:00Z

const MEETUP_ID = "55555555-5555-4555-8555-555555555555";
const none = json({ google: { status: "none", connectedAt: null } });
const connected = json({ google: { status: "connected", connectedAt: "2026-10-01T00:00:00.000Z" } });
const needsReauth = json({ google: { status: "needs_reauth", connectedAt: "2026-10-01T00:00:00.000Z" } });
const problem = (status: number, code: string) => json({ type: "about:blank", title: "x", status, code, requestId: "r" }, status);

const CONNECTED_LINE = "連携中なので、Googleカレンダーの『ここ暇』に自動で入ります";
const CONNECT = "Googleカレンダーに自動で入れる";
const OTHER_ICS = "ほかのカレンダーに追加（.ics）";

const meetupBody = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

/** 成立の演出は見たことにして、ふつうの詳細を開く（T-43） */
function openMeetup(routes: Parameters<typeof mockFetch>[0], path = `/meetups/${MEETUP_ID}`, meetup = meetupBody()) {
  markMeetMomentSeen(MEETUP_ID);
  window.history.replaceState(null, "", path);
  return mockFetch({ "/api/v1/auth/refresh": json(tokenBody()), [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup), ...routes });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  tokenStore.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("連携の状態ごとの見た目", () => {
  it("連携中：「自動で入ります」の静かな1行（✓ なし）。.ics は「ほかのカレンダーに追加（.ics）」", async () => {
    openMeetup({ "/api/v1/calendar/connections": connected });
    renderApp();
    const line = await screen.findByText(CONNECTED_LINE);
    expect(line).toHaveClass("text-ink-muted");
    expect(line.textContent).not.toMatch(/✓/);
    expect(screen.getByRole("button", { name: OTHER_ICS })).toBeVisible();
    expect(screen.queryByRole("button", { name: CONNECT })).toBeNull();
  });

  it("連携していない：主のボタンと説明。押すと { meetupId } を送り、authorizeUrl へ移る", async () => {
    const go = vi.spyOn(redirectTo, "go").mockImplementation(() => {});
    const { calls } = openMeetup({
      "/api/v1/calendar/connections": none,
      "/api/v1/calendar/google/authorizations": json({ authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=2" }),
    });
    renderApp();
    const button = await screen.findByRole("button", { name: CONNECT });
    expect(button.className).toContain("bg-action");
    expect(screen.getByText("連携すると、これからの予定もまとめて入ります。読むのは空き／埋まりだけです")).toBeVisible();
    // .ics は Google の行の下
    const ics = screen.getByRole("button", { name: OTHER_ICS });
    expect(button.compareDocumentPosition(ics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(button);
    await waitFor(() => expect(go).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=2"));
    const post = calls.find((c) => c.url === "/api/v1/calendar/google/authorizations");
    expect(post?.init.method).toBe("POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({ meetupId: MEETUP_ID });
  });

  it("連携を始められない・回数の上限は、赤を使わず静かに出す", async () => {
    const go = vi.spyOn(redirectTo, "go").mockImplementation(() => {});
    openMeetup({
      "/api/v1/calendar/connections": none,
      "/api/v1/calendar/google/authorizations": [problem(500, "internal"), problem(429, "rate_limited")],
    });
    renderApp();
    const button = await screen.findByRole("button", { name: CONNECT });
    await userEvent.click(button);
    const failed = await screen.findByText("連携を始められませんでした。もう一度お試しください");
    expect(failed.className).not.toMatch(/red|rose|danger|error/);
    await userEvent.click(button);
    const limited = await screen.findByText("少し待ってから、もう一度お試しください");
    expect(limited.className).not.toMatch(/red|rose|danger|error/);
    expect(go).not.toHaveBeenCalled();
  });

  it("もう一度連携が要る：静かな1行と、設定へのリンク", async () => {
    openMeetup({ "/api/v1/calendar/connections": needsReauth });
    renderApp();
    const link = await screen.findByRole("link", { name: "カレンダー連携へ" });
    expect(link).toHaveAttribute("href", "/settings/calendar");
    expect(screen.getByText(/Googleカレンダーに入れるには、もう一度連携してください/)).toHaveClass("text-ink-muted");
    expect(screen.queryByRole("button", { name: CONNECT })).toBeNull();
    expect(screen.getByRole("button", { name: OTHER_ICS })).toBeVisible();
  });
});

describe("Google の行を出さないとき", () => {
  it.each([
    ["取り消した・抜けた予定（cancelled）", { status: "cancelled" }],
    ["終わった予定", { startsAt: "2026-10-09T10:00:00.000Z", endsAt: "2026-10-09T14:00:00.000Z" }],
  ])("%sには出さず、連携の状態も読まない。.ics は「カレンダーに追加（.ics）」", async (_name, over) => {
    const { calls } = openMeetup({ "/api/v1/calendar/connections": none }, `/meetups/${MEETUP_ID}`, meetupBody(over));
    renderApp();
    expect(await screen.findByRole("button", { name: "カレンダーに追加（.ics）" })).toBeVisible();
    expect(screen.queryByRole("button", { name: CONNECT })).toBeNull();
    expect(calls.some((c) => c.url === "/api/v1/calendar/connections")).toBe(false);
  });

  it("連携の状態を読めないときは出さず、失敗の文言も出さない", async () => {
    const { calls } = openMeetup({ "/api/v1/calendar/connections": problem(500, "internal") });
    renderApp();
    expect(await screen.findByRole("button", { name: "カレンダーに追加（.ics）" })).toBeVisible();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/calendar/connections")).toBe(true));
    expect(screen.queryByText(/連携/)).toBeNull();
    expect(screen.queryByRole("button", { name: OTHER_ICS })).toBeNull();
  });
});

describe("連携から戻ってきたとき（?calendar=）", () => {
  it("connected：結果の帯が1回だけ出て、連携の状態を読み直す。後ろは誘いタブ", async () => {
    const { calls } = openMeetup({ "/api/v1/calendar/connections": connected }, `/meetups/${MEETUP_ID}?calendar=connected`);
    // 連携する前に読んだ「連携していない」が手元に残っていても、読み直す
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(keys.calendar.connections(), { google: { status: "none", connectedAt: null } });
    renderApp(client);
    const band = screen.getByTestId("result-band");
    expect(await within(band).findByText("連携しました。Googleカレンダーの『ここ暇』に入ります")).toBeVisible();
    expect(await screen.findByText(CONNECTED_LINE)).toBeVisible();
    expect(screen.getAllByText("連携しました。Googleカレンダーの『ここ暇』に入ります")).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/v1/calendar/connections")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "成立した予定" })).toBeVisible();
  });

  it("failed：結果の帯に「連携できませんでした」（赤なし）。欄は連携していないまま", async () => {
    openMeetup({ "/api/v1/calendar/connections": none }, `/meetups/${MEETUP_ID}?calendar=failed`);
    renderApp();
    const band = screen.getByTestId("result-band");
    expect(await within(band).findByText("連携できませんでした。もう一度お試しください")).toBeVisible();
    expect(band.innerHTML).not.toMatch(/red|rose/);
    expect(await screen.findByRole("button", { name: CONNECT })).toBeVisible();
  });
});
