import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody, type Route } from "../test/helpers";

// 「ここどう？」の入口と、友達の有無で分けた空の状態（docs/specs/T-34-kokodou-entry.md）
// 時計は 2026-10-10T00:00:00Z（東京は土曜 09:00）

type Routes = Record<string, Route | Route[]>;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const empty = json({ items: [], nextCursor: null });
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
});
const friend = (n: number, name: string | null) => ({
  id: uuid(n),
  displayName: name,
  avatarUrl: null,
  sharesMyAvailability: true,
  friendsSince: "2026-10-07T00:00:00.000Z",
});
const slot = (n: number, name: string) => ({
  friend: { id: uuid(n), displayName: name, avatarUrl: null },
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  label: "night",
  overlapsMine: false,
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

const everyoneTab = (over: Routes = {}) => {
  window.history.replaceState(null, "", "/");
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/friends": json({ items: [friend(1, "あき"), friend(2, "はる")], nextCursor: null }),
    "/api/v1/friend-availabilities": empty,
    "/api/v1/friend-wishes": empty,
    ...over,
  });
};

const whoToInvite = () => screen.findByRole("region", { name: "誰を誘う？" });

describe("誰を誘う？（顔の列）", () => {
  it("友達全員を、友達の一覧の並びのまま出す（続きのページも読む）。押すとその友達を入れた誘いの作成へ", async () => {
    const { calls } = everyoneTab({
      "/api/v1/friends": [
        json({ items: [friend(1, "あき"), friend(2, null)], nextCursor: "c1" }),
        json({ items: [friend(3, "なつ")], nextCursor: null }),
      ],
    });
    renderApp();
    const row = await whoToInvite();
    await waitFor(() => expect(within(row).getAllByRole("link")).toHaveLength(3));
    const links = within(row).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual(["あきを誘う", "名前未設定の友達を誘う", "なつを誘う"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([1, 2, 3].map((n) => `/invites/new?friend=${uuid(n)}`));
    expect(calls.some((c) => c.url === "/api/v1/friends?limit=50&cursor=c1")).toBe(true);
    // 顔の列は横にスクロールする
    expect(within(row).getByRole("list").className).toContain("overflow-x-auto");
  });

  it("見せない相手（ここ暇が届かない）と、ここ暇がない相手、ここ暇がある相手を、顔の列では同じ形で出す", async () => {
    // あき：ここ暇が見えている。はる：見せないにされている（API の結果に出ない）。なつ：ここ暇がない（同じく出ない）
    everyoneTab({
      "/api/v1/friends": json({ items: [friend(1, "あき"), friend(2, "はる"), friend(3, "なつ")], nextCursor: null }),
      "/api/v1/friend-availabilities": json({ items: [slot(1, "あき")], nextCursor: null }),
    });
    renderApp();
    await screen.findByText("夜 19:00〜23:00");
    const row = await whoToInvite();
    const items = within(row).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // 名前を除いた形（要素・属性・クラス）が同じ。ここ暇の有無の印も、並べ替えもない
    const shape = (li: HTMLElement, n: number, name: string) => li.innerHTML.replaceAll(uuid(n), "ID").replaceAll(name, "NAME").replaceAll(name.charAt(0), "頭文字");
    const [a, h, n] = items as [HTMLElement, HTMLElement, HTMLElement];
    expect(shape(h, 2, "はる")).toBe(shape(n, 3, "なつ"));
    expect(shape(a, 1, "あき")).toBe(shape(n, 3, "なつ"));
    expect(within(row).getAllByRole("link").map((l) => l.getAttribute("aria-label"))).toEqual(["あきを誘う", "はるを誘う", "なつを誘う"]);
  });

  it("顔を押すと誘いの作成が相手を入れて開き、相手のここ暇と重ならなければ「ここどう？」になる", async () => {
    everyoneTab({
      "/api/v1/me/presets": presets,
      [`/api/v1/friends/${uuid(2)}/availabilities`]: empty,
    });
    renderApp();
    const row = await whoToInvite();
    await userEvent.click(await within(row).findByRole("link", { name: "はるを誘う" }));
    expect(window.location.pathname).toBe("/invites/new");
    expect(window.location.search).toBe(`?friend=${uuid(2)}`);
    const sheet = await screen.findByRole("dialog", { name: "誘う" });
    await waitFor(() => expect(within(sheet).getByLabelText("相手")).toHaveValue(uuid(2)));
    expect(await within(sheet).findByText("ここどう？", { exact: true })).toBeVisible();
    expect(within(sheet).getByText("相手のここ暇とは重なっていません")).toBeVisible();
  });

  it("友達の一覧を読めなければ、静かに「友達を読み込めませんでした」と「もう一度」。募るボタンは出したまま", async () => {
    everyoneTab({
      "/api/v1/friends": [json({ type: "about:blank", title: "Internal Server Error", status: 500 }, 500), json({ items: [friend(1, "あき")], nextCursor: null })],
    });
    renderApp();
    const text = await screen.findByText("友達を読み込めませんでした");
    expect(text.className).not.toMatch(/red|rose|danger/);
    expect(screen.getByRole("link", { name: "暇な人いる？と募る" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "もう一度" }));
    expect(await within(await whoToInvite()).findByRole("link", { name: "あきを誘う" })).toBeVisible();
  });
});

describe("空の状態（友達の有無で分ける）", () => {
  it("友達がいて、見えているここ暇がない：顔の列と募るボタンと「まだ友達のここ暇はありません」。招待のボタンは出さない", async () => {
    everyoneTab();
    renderApp();
    expect(await screen.findByText("まだ友達のここ暇はありません")).toBeVisible();
    expect(within(await whoToInvite()).getByRole("link", { name: "あきを誘う" })).toBeVisible();
    expect(screen.getByText("ここ暇がなくても、上の顔から「ここどう？」と誘えます")).toBeVisible();
    expect(screen.getByRole("link", { name: "暇な人いる？と募る" })).toHaveAttribute("href", "/broadcasts/new");
    expect(screen.queryByRole("button", { name: "友達を招待する" })).toBeNull();
    expect(screen.queryByText("まだ友達はいません")).toBeNull();
  });

  it("友達が0人：「まだ友達はいません」と招待の1つのボタンだけ。押すと招待リンクの発行のシートが開く", async () => {
    everyoneTab({
      "/api/v1/friends": empty,
      "/api/v1/me": json({ id: uuid(900), displayName: "わたし", avatarUrl: null }),
    });
    renderApp();
    expect(await screen.findByText("まだ友達はいません")).toBeVisible();
    expect(screen.getByText("友達を招待すると、ここに暇な時間が並びます")).toBeVisible();
    expect(screen.queryByRole("region", { name: "誰を誘う？" })).toBeNull();
    expect(screen.queryByRole("link", { name: "暇な人いる？と募る" })).toBeNull();
    expect(screen.queryByText("まだ友達のここ暇はありません")).toBeNull();
    const main = screen.getByRole("main");
    expect(within(main).getAllByRole("button")).toHaveLength(1);
    expect(within(main).queryAllByRole("link")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "友達を招待する" }));
    const sheet = await screen.findByRole("dialog", { name: "招待リンクを作る" });
    expect(await within(sheet).findByRole("button", { name: "招待リンクを作る" })).toBeVisible();
  });
});

describe("友達の詳細", () => {
  it("誘いの作成への入口は「誘う」（重なれば「あそぼ」、重ならなければ「ここどう？」になるため）", async () => {
    window.history.replaceState(null, "", `/friends/${uuid(1)}`);
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      [`/api/v1/friends/${uuid(1)}`]: json(friend(1, "あき")),
      [`/api/v1/friends/${uuid(1)}/availabilities`]: empty,
      [`/api/v1/friends/${uuid(1)}/wishes`]: empty,
      "/api/v1/friends": json({ items: [friend(1, "あき")], nextCursor: null }),
    });
    renderApp();
    const sheet = await screen.findByRole("dialog", { name: "あき" });
    expect(await within(sheet).findByRole("link", { name: "誘う" })).toHaveAttribute("href", `/invites/new?friend=${uuid(1)}`);
    expect(within(sheet).queryByRole("link", { name: "ここどう？と誘う" })).toBeNull();
  });
});
