import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { deviceCalendarLabel } from "../calendar/deviceCalendar";
import { markMeetMomentSeen } from "../invitations/meetMomentSeen";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { redirectTo } from "./CalendarSettingsPage";

// 成立した予定のカレンダーへの入れ方の欄（docs/specs/T-59-choose-calendar-add.md「振る舞い 1.」）。時計は 2026-10-10T00:00:00Z

const MEETUP_ID = "55555555-5555-4555-8555-555555555555";
const problem = (status: number, code: string) => json({ type: "about:blank", title: "x", status, code, requestId: "r" }, status);
const ADD = "カレンダーに追加";
const GOOGLE = "Googleカレンダーに追加";
// テストの端末（jsdom）は iPhone・iPad・Mac のどれでもない
const DEVICE = "ほかのカレンダーに追加";

const meetupBody = (over: Record<string, unknown> = {}) => ({
  id: MEETUP_ID,
  startsAt: "2026-10-11T10:00:00.000Z",
  endsAt: "2026-10-11T14:00:00.000Z",
  status: "confirmed",
  participants: [{ id: "22222222-2222-4222-8222-222222222222", displayName: "あき", avatarUrl: null, withdrawn: false }],
  area: "渋谷",
  message: "ひみつのひとこと",
  url: null,
  linkPreview: null,
  directInviteId: null,
  broadcastId: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  ...over,
});

/** 成立の演出は見たことにして、ふつうの詳細を開く（T-43） */
function openMeetup(routes: Parameters<typeof mockFetch>[0] = {}, path = `/meetups/${MEETUP_ID}`, meetup = meetupBody()) {
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

describe("「カレンダーに追加」を押すと、その場で選択肢が開く", () => {
  it("最初は閉じている。押すと Google と端末のカレンダーが開き、もう一度押すと閉じる。連携の状態は読まない", async () => {
    const { calls } = openMeetup();
    renderApp();
    const button = await screen.findByRole("button", { name: ADD });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: GOOGLE })).toBeNull();
    expect(screen.queryByText("押した予定だけが入ります")).toBeNull();

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(button.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    const google = within(panel as HTMLElement).getByRole("link", { name: GOOGLE });
    const device = within(panel as HTMLElement).getByRole("button", { name: DEVICE });
    expect(google.compareDocumentPosition(device) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("押した予定だけが入ります")).toHaveClass("text-ink-muted");
    // 「.ics」とは書かない。主のボタン（青い面）にしない。赤・エラー色を使わない
    expect(document.body.textContent).not.toMatch(/\.ics/);
    expect(button.className).not.toContain("bg-action");
    expect(panel?.parentElement?.parentElement?.innerHTML).not.toMatch(/red|rose|danger|error/);

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("押した予定だけが入ります")).toBeNull();
    expect(calls.some((c) => c.url === "/api/v1/calendar/connections")).toBe(false);
  });

  it("Google のリンク：新しいタブで、日時・場所・タイトル入りの追加画面。ひとことは入れない", async () => {
    openMeetup();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: ADD }));
    const google = screen.getByRole("link", { name: GOOGLE });
    expect(google).toHaveAttribute("target", "_blank");
    expect(google).toHaveAttribute("rel", "noopener noreferrer");
    const url = new URL(google.getAttribute("href") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("ここ暇：あき");
    expect(url.searchParams.get("dates")).toBe("20261011T100000Z/20261011T140000Z");
    expect(url.searchParams.get("location")).toBe("渋谷");
    expect(url.searchParams.get("details")).toBe(`${window.location.origin}/meetups/${MEETUP_ID}`);
    expect(url.toString()).not.toContain(encodeURIComponent("ひみつ"));
  });

  it("端末のカレンダー：押すと一時的な URL を発行して移る。失敗・上限は選択肢の下に静かに出し、閉じない", async () => {
    const go = vi.spyOn(redirectTo, "go").mockImplementation(() => {});
    const link = `https://app.test/api/v1/ics/${"a".repeat(43)}`;
    openMeetup({
      [`/api/v1/meetups/${MEETUP_ID}/ics-links`]: [
        problem(500, "internal"),
        problem(429, "rate_limited"),
        json({ url: link, expiresAt: "2026-10-10T00:05:00.000Z" }),
      ],
    });
    renderApp();
    const button = await screen.findByRole("button", { name: ADD });
    await userEvent.click(button);
    const device = screen.getByRole("button", { name: DEVICE });
    await userEvent.click(device);
    const failed = await screen.findByText("カレンダーに追加できませんでした。もう一度お試しください");
    expect(failed.className).not.toMatch(/red|rose|danger|error/);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(device);
    expect(await screen.findByText("少し待ってから、もう一度お試しください")).toBeVisible();
    await userEvent.click(device);
    await waitFor(() => expect(go).toHaveBeenCalledWith(link));
  });

  it("オフラインの間は端末のカレンダーを押せない（T-11）", async () => {
    const { calls } = openMeetup();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: ADD }));
    const device = screen.getByRole("button", { name: DEVICE });
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(device).toBeDisabled();
    await userEvent.click(device);
    expect(calls.some((c) => c.url.endsWith("/ics-links"))).toBe(false);
    onLine.mockRestore();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
  });
});

describe("出さないとき", () => {
  it.each([
    ["取り消した・抜けた予定（cancelled）", { status: "cancelled" }],
    ["終わった予定", { startsAt: "2026-10-09T10:00:00.000Z", endsAt: "2026-10-09T14:00:00.000Z" }],
  ])("%sには「カレンダーに追加」を出さない", async (_name, over) => {
    openMeetup({}, `/meetups/${MEETUP_ID}`, meetupBody(over));
    renderApp();
    expect(await screen.findByRole("heading", { name: "成立した予定" })).toBeVisible();
    await screen.findByText("あき");
    expect(screen.queryByRole("button", { name: ADD })).toBeNull();
  });

  it("他人のIDでは取得できない：参加者でない予定（404）では欄を出さない", async () => {
    openMeetup({ [`/api/v1/meetups/${MEETUP_ID}`]: problem(404, "not_found") });
    renderApp();
    expect(await screen.findByText("この予定は見つかりませんでした。")).toBeVisible();
    expect(screen.queryByRole("button", { name: ADD })).toBeNull();
  });
});

describe("連携から戻ってきたとき（?calendar=）", () => {
  it("connected：結果の帯は「連携しました」だけ（自動で入るとは言わない）", async () => {
    openMeetup({ "/api/v1/calendar/connections": json({ google: { status: "connected", connectedAt: "2026-10-01T00:00:00.000Z" } }) }, `/meetups/${MEETUP_ID}?calendar=connected`);
    renderApp();
    const band = screen.getByTestId("result-band");
    expect(await within(band).findByText("連携しました")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/自動で入/);
  });
});

describe("端末ごとの名前（deviceCalendarLabel）", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15", 5, "iPhoneのカレンダーに追加"],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15", 5, "iPadのカレンダーに追加"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5, "iPadのカレンダーに追加"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 0, "Macのカレンダーに追加"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36", 5, "ほかのカレンダーに追加"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", 0, "ほかのカレンダーに追加"],
  ])("%s（タッチ点 %i）は「%s」", (ua, touch, label) => {
    expect(deviceCalendarLabel(ua, touch)).toBe(label);
  });
});
