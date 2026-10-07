import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { formatSlot } from "../availability/format";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

// 時計は 2026-10-10T00:00:00Z（東京は土曜 09:00）
const FRIEND_ID = "22222222-2222-4222-8222-222222222222";
const SLOT_ID = "33333333-3333-4333-8333-333333333333";
const RULE_ID = "44444444-4444-4444-8444-444444444444";
const empty = json({ items: [], nextCursor: null });
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
});
const manual = {
  source: "manual",
  id: SLOT_ID,
  date: null,
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  label: "night",
};
const repeated = {
  source: "recurrence",
  id: RULE_ID,
  date: "2026-10-11",
  startsAt: "2026-10-11T02:00:00.000Z",
  endsAt: "2026-10-11T06:00:00.000Z",
  label: "day",
};
const friend = { id: FRIEND_ID, displayName: "あき", avatarUrl: null };

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

const availabilityTab = (over: Record<string, Parameters<typeof mockFetch>[0][string]> = {}) => {
  window.history.replaceState(null, "", "/availability");
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/me/presets": presets,
    "/api/v1/availabilities": json({ items: [manual, repeated], nextCursor: null }),
    "/api/v1/recurrence-rules": empty,
    ...over,
  });
};

describe("表示", () => {
  it("「夜 19:00〜23:00」のように時刻を併記し、プリセット名がなければ時刻だけ。翌日の0:00は24:00", () => {
    expect(formatSlot({ startsAt: "2026-10-10T10:00:00Z", endsAt: "2026-10-10T14:00:00Z", label: "night" })).toBe(
      "夜 19:00〜23:00",
    );
    expect(formatSlot({ startsAt: "2026-10-10T13:00:00Z", endsAt: "2026-10-10T15:00:00Z", label: null })).toBe("22:00〜24:00");
    expect(formatSlot({ startsAt: "2026-10-10T13:00:00Z", endsAt: "2026-10-10T17:00:00Z", label: null })).toBe(
      "22:00〜10/11（日） 02:00",
    );
  });
});

describe("みんな", () => {
  it("日付ごとに友達の表示名と時刻を出し、自分と重なる枠に印をつける。今日から7日分を読む", async () => {
    window.history.replaceState(null, "", "/");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/friend-availabilities": json({
        items: [
          { friend, startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z", label: "night", overlapsMine: true },
          { friend, startsAt: "2026-10-12T02:00:00.000Z", endsAt: "2026-10-12T06:00:00.000Z", label: "day", overlapsMine: false },
        ],
        nextCursor: null,
      }),
    });
    renderApp();
    const first = (await screen.findByText("夜 19:00〜23:00")).closest("li") as HTMLElement;
    expect(within(first).getByRole("link", { name: "あき" })).toHaveAttribute("href", `/friends/${FRIEND_ID}`);
    expect(within(first).getByText("自分のここ暇と重なっています")).toBeVisible();
    const second = screen.getByText("昼 11:00〜15:00").closest("li") as HTMLElement;
    expect(within(second).queryByText("自分のここ暇と重なっています")).toBeNull();
    expect(screen.getByRole("heading", { name: "10/10（土）" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "10/12（月）" })).toBeVisible();
    const url = new URL(calls.find((c) => c.url.startsWith("/api/v1/friend-availabilities"))?.url ?? "", "http://x");
    expect(url.searchParams.get("from")).toBe("2026-10-09T15:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-10-16T15:00:00.000Z");
  });

  it("続きがあれば最後まで読む。空なら「まだ友達のここ暇はありません」", async () => {
    window.history.replaceState(null, "", "/");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/friend-availabilities": [json({ items: [], nextCursor: "next-1" }), empty],
    });
    renderApp();
    expect(await screen.findByText("まだ友達のここ暇はありません")).toBeVisible();
    const pages = calls.filter((c) => c.url.startsWith("/api/v1/friend-availabilities"));
    expect(pages).toHaveLength(2);
    expect(pages[1]?.url).toContain("cursor=next-1");
  });
});

describe("ここ暇タブ", () => {
  it("「夜」のボタンを押すと、選んだ日付とプリセット名で作る", async () => {
    const { calls } = availabilityTab({
      "/api/v1/availabilities": [empty, json(manual, 201), json({ items: [manual], nextCursor: null })],
    });
    renderApp();
    expect(await screen.findByText("昼 11:00〜15:00・夕方 16:00〜19:00・夜 19:00〜23:00")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "夜" }));
    const post = await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/v1/availabilities" && x.init.method === "POST");
      expect(c).toBeDefined();
      return c;
    });
    expect(JSON.parse(String(post?.init.body))).toEqual({ date: "2026-10-10", preset: "night" });
    expect(await within(screen.getByRole("list", { name: "自分のここ暇" })).findByText(/夜 19:00〜23:00/)).toBeVisible();
  });

  it("重なりで作れなければ静かな文言（赤を使わない）", async () => {
    availabilityTab({ "/api/v1/availabilities": [empty, json({}, 409)] });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "昼" }));
    const message = await screen.findByText(/自分のほかのここ暇と重なっているか/);
    expect(message.className).not.toMatch(/red/);
  });

  it("取り消しは押したらすぐ消え、失敗したら元に戻して静かな文言を出す", async () => {
    let fail: (r: Response) => void = () => {};
    availabilityTab({
      [`/api/v1/availabilities/${SLOT_ID}`]: () => new Promise<Response>((resolve) => (fail = resolve)),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "自分のここ暇" });
    const row = (await within(list).findByText(/夜 19:00〜23:00/)).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(within(list).queryByText(/夜 19:00〜23:00/)).toBeNull());
    expect(within(list).getByText(/昼 11:00〜15:00/)).toBeVisible();
    fail(new Response(null, { status: 503 }));
    expect(await screen.findByText("変更できませんでした。もう一度お試しください。")).toBeVisible();
    expect(await within(list).findByText(/夜 19:00〜23:00/)).toBeVisible();
  });

  it("くり返しの枠は「この日だけ外す」で、その日付を例外に送る", async () => {
    const { calls } = availabilityTab({
      [`/api/v1/recurrence-rules/${RULE_ID}/exceptions`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "自分のここ暇" });
    const row = (await within(list).findByText(/昼 11:00〜15:00/)).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "この日だけ外す" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/exceptions"))).toBe(true));
    const call = calls.find((c) => c.url.endsWith("/exceptions"));
    expect(JSON.parse(String(call?.init.body))).toEqual({ date: "2026-10-11" });
  });
});

describe("友達の詳細", () => {
  const detail = (slots: unknown[], status = 200) => {
    window.history.replaceState(null, "", `/friends/${FRIEND_ID}`);
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      [`/api/v1/friends/${FRIEND_ID}`]: json(
        { ...friend, sharesMyAvailability: true, friendsSince: "2026-10-07T00:00:00.000Z" },
        status,
      ),
      [`/api/v1/friends/${FRIEND_ID}/availabilities`]: json({ items: slots, nextCursor: null }),
    });
  };

  it("見えているここ暇を時刻つきで出し、なければ「見えているここ暇はありません」", async () => {
    detail([{ startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z", label: "night" }]);
    const view = renderApp();
    expect(await screen.findByRole("heading", { name: "あき" })).toBeVisible();
    expect(await screen.findByText("10/10（土） 夜 19:00〜23:00")).toBeVisible();
    view.unmount();
    detail([]);
    renderApp();
    expect(await screen.findByText("見えているここ暇はありません")).toBeVisible();
  });

  it("友達でなければ（404）見つからない表示", async () => {
    detail([], 404);
    renderApp();
    expect(await screen.findByText("この友達は見つかりませんでした。")).toBeVisible();
  });
});
