import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

// 行きたい（docs/specs/T-22-wishlist.md「画面」「誘い・募集の作成画面に入れる」）
// 時計は 2026-10-10T00:00:00Z（東京は土曜 09:00）

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = uuid(900);
const FRIEND = uuid(1);
const WISH_ID = uuid(500);
const empty = json({ items: [], nextCursor: null });
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
});
const profile = (id: string, name: string) => ({ id, displayName: name, avatarUrl: null });
const friend = (n: number, name = `友${n}`) => ({
  ...profile(uuid(n), name),
  sharesMyAvailability: true,
  friendsSince: "2026-10-07T00:00:00.000Z",
});
const wish = (over: Record<string, unknown> = {}) => ({
  id: WISH_ID,
  owner: profile(ME, "わたし"),
  message: "〇〇のラーメン行きたい",
  area: "渋谷",
  url: null,
  linkPreview: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  excludedUsers: [],
  ...over,
});
const friendsWish = (over: Record<string, unknown> = {}) =>
  wish({ owner: profile(FRIEND, "あき"), excludedUsers: null, ...over });

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

type Routes = Parameters<typeof mockFetch>[0];

const availabilityTab = (over: Routes = {}) => {
  window.history.replaceState(null, "", "/availability");
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/me/presets": presets,
    "/api/v1/availabilities": empty,
    "/api/v1/recurrence-rules": empty,
    "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
    "/api/v1/wishes": json({ items: [wish()], nextCursor: null }),
    "/api/v1/friends": json({ items: [friend(1), friend(2)], nextCursor: null }),
    ...over,
  });
};

describe("自分の行きたい（ここ暇のタブ）", () => {
  it("置く：ひとこと・リンク・エリアと、外す人を送る。置いたら一覧を読み直す", async () => {
    const { calls } = availabilityTab({
      "/api/v1/wishes": [json({ items: [], nextCursor: null }), json(wish({ message: "キャンプ" }), 201), json({ items: [wish({ message: "キャンプ" })], nextCursor: null })],
    });
    renderApp();
    await screen.findByText("行きたいはまだありません");
    await userEvent.click(screen.getByRole("button", { name: "＋ 行きたいを置く" }));
    const dialog = await screen.findByRole("dialog", { name: "行きたいを置く" });
    expect(within(dialog).getByRole("button", { name: "置く" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("ひとこと"), "キャンプ");
    await userEvent.type(within(dialog).getByLabelText("リンク（任意）"), "https://example.com/camp");
    expect(within(dialog).getByText("友達全員")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "外す人を選ぶ" }));
    await userEvent.click(await within(dialog).findByLabelText("友2"));
    await userEvent.click(within(dialog).getByRole("button", { name: "置く" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "行きたいを置く" })).toBeNull());
    const post = calls.find((c) => c.url === "/api/v1/wishes" && c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({
      message: "キャンプ",
      area: null,
      url: "https://example.com/camp",
      excludedUserIds: [uuid(2)],
    });
    expect(new Headers(post?.init.headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("リンク付きの行きたいに OGP のカードが出る。取れなければドメインだけ", async () => {
    availabilityTab({
      "/api/v1/wishes": json({
        items: [
          wish({
            id: uuid(501),
            message: "取れた",
            url: "https://shop.example.com/a",
            linkPreview: { status: "ok", title: "お店のページ", description: "説明", siteName: "サイト", imageUrl: null },
          }),
          wish({
            id: uuid(502),
            message: "取れなかった",
            url: "https://other.example.com/b",
            linkPreview: { status: "failed", title: null, description: null, siteName: null, imageUrl: null },
          }),
        ],
        nextCursor: null,
      }),
    });
    renderApp();
    expect(await screen.findByText("お店のページ")).toBeVisible();
    expect(screen.getByText("other.example.com")).toBeVisible();
  });

  it("友達全員のままなら、外す人は空で送る", async () => {
    const { calls } = availabilityTab({
      "/api/v1/wishes": [json({ items: [], nextCursor: null }), json(wish(), 201), json({ items: [wish()], nextCursor: null })],
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "＋ 行きたいを置く" }));
    const dialog = await screen.findByRole("dialog", { name: "行きたいを置く" });
    await userEvent.type(within(dialog).getByLabelText("ひとこと"), "ラーメン");
    await userEvent.click(within(dialog).getByRole("button", { name: "置く" }));
    const isPost = (c: { url: string; init: RequestInit }) => c.url === "/api/v1/wishes" && c.init.method === "POST";
    await waitFor(() => expect(calls.some(isPost)).toBe(true));
    const post = calls.find(isPost);
    expect(JSON.parse(String(post?.init.body))).toMatchObject({ excludedUserIds: [] });
    // 友達の一覧は「外す人を選ぶ」を押すまで読まない
    expect(calls.some((c) => c.url.startsWith("/api/v1/friends"))).toBe(false);
  });

  it("置けなかったとき（429）は静かな文言", async () => {
    availabilityTab({
      "/api/v1/wishes": [json({ items: [], nextCursor: null }), json({ code: "rate_limited" }, 429)],
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "＋ 行きたいを置く" }));
    const dialog = await screen.findByRole("dialog", { name: "行きたいを置く" });
    await userEvent.type(within(dialog).getByLabelText("ひとこと"), "ラーメン");
    await userEvent.click(within(dialog).getByRole("button", { name: "置く" }));
    const message = await within(dialog).findByText("今日はたくさん置いたので、少し時間をおいてください");
    expect(message.className).not.toMatch(/red|rose/);
  });

  it("10件あると置くボタンを押せず、案内を出す", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => wish({ id: uuid(600 + i), message: `行きたい${i}` }));
    availabilityTab({ "/api/v1/wishes": json({ items: ten, nextCursor: null }) });
    renderApp();
    expect(await screen.findByText("置けるのは10件までです。消すとまた置けます")).toBeVisible();
    expect(screen.getByRole("button", { name: "＋ 行きたいを置く" })).toBeDisabled();
  });

  it("誘う・募集するは ?wish=<id> で作成画面を開く", async () => {
    availabilityTab();
    renderApp();
    const list = await screen.findByRole("list", { name: "自分の行きたい" });
    expect(within(list).getByText("〇〇のラーメン行きたい")).toBeVisible();
    expect(within(list).getByRole("link", { name: "誘う" })).toHaveAttribute("href", `/invites/new?wish=${WISH_ID}`);
    expect(within(list).getByRole("link", { name: "募集する" })).toHaveAttribute("href", `/broadcasts/new?wish=${WISH_ID}`);
  });

  it("消す：確認してから消す", async () => {
    const { calls } = availabilityTab({
      "/api/v1/wishes": [json({ items: [wish()], nextCursor: null }), empty],
      [`/api/v1/wishes/${WISH_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "自分の行きたい" });
    await userEvent.click(within(list).getByRole("button", { name: "消す" }));
    const dialog = await screen.findByRole("dialog", { name: "行きたいを消す" });
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "消す" }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/v1/wishes/${WISH_ID}` && c.init.method === "DELETE")).toBe(true));
    expect(await screen.findByText("行きたいはまだありません")).toBeVisible();
  });

  it("見せる相手：今の友達の一覧にいない人は送らない（友達でなくなった人が残っても404にならない）", async () => {
    const { calls } = availabilityTab({
      "/api/v1/wishes": json({ items: [wish({ excludedUsers: [profile(uuid(2), "友2"), profile(uuid(3), "元友")] })], nextCursor: null }),
      [`/api/v1/wishes/${WISH_ID}/exclusions`]: json(wish()),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "自分の行きたい" });
    await userEvent.click(within(list).getByRole("button", { name: "見せる相手" }));
    const dialog = await screen.findByRole("dialog", { name: "見せる相手" });
    await within(dialog).findByLabelText("友1");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(calls.some((c) => c.init.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.init.method === "PUT");
    expect(JSON.parse(String(put?.init.body))).toEqual({ userIds: [uuid(2)] });
  });

  it("見せる相手：外していた人を戻すときに注意を出し、一覧ごと送る", async () => {
    const { calls } = availabilityTab({
      "/api/v1/wishes": json({ items: [wish({ excludedUsers: [profile(uuid(2), "友2")] })], nextCursor: null }),
      [`/api/v1/wishes/${WISH_ID}/exclusions`]: json(wish()),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "自分の行きたい" });
    await userEvent.click(within(list).getByRole("button", { name: "見せる相手" }));
    const dialog = await screen.findByRole("dialog", { name: "見せる相手" });
    const shown = await within(dialog).findByLabelText("友2");
    expect(shown).not.toBeChecked();
    expect(within(dialog).getByLabelText("友1")).toBeChecked();
    expect(within(dialog).queryByText("戻すと、外していたことに気づかれることがあります")).toBeNull();
    await userEvent.click(shown);
    expect(within(dialog).getByText("戻すと、外していたことに気づかれることがあります")).toBeVisible();
    await userEvent.click(within(dialog).getByLabelText("友1"));
    await userEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(calls.some((c) => c.init.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.init.method === "PUT");
    expect(JSON.parse(String(put?.init.body))).toEqual({ userIds: [uuid(1)] });
  });
});

const everyoneTab = (over: Routes = {}) => {
  window.history.replaceState(null, "", "/");
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/friend-availabilities": empty,
    "/api/v1/friends": json({ items: [friend(1, "あき")], nextCursor: null }),
    ...over,
  });
};

describe("友達の行きたい（みんな）", () => {
  it("友達ごとにまとめ、「ここで誘う」で ?wish=<id> を開く。もっと見るで続きを読む", async () => {
    const second = { friend: profile(uuid(2), "はる"), wishes: [friendsWish({ id: uuid(501), owner: profile(uuid(2), "はる"), message: "映画" })] };
    const { calls } = everyoneTab({
      "/api/v1/friend-wishes": [
        json({ items: [{ friend: profile(FRIEND, "あき"), wishes: [friendsWish()] }], nextCursor: "c1" }),
        json({ items: [second], nextCursor: null }),
      ],
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "友達の行きたい" });
    expect(within(list).getByText("あき")).toBeVisible();
    expect(within(list).getByRole("link", { name: "ここで誘う" })).toHaveAttribute("href", `/invites/new?wish=${WISH_ID}`);
    await userEvent.click(screen.getByRole("button", { name: "もっと見る" }));
    expect(await within(list).findByText("映画")).toBeVisible();
    expect(calls.some((c) => c.url === "/api/v1/friend-wishes?cursor=c1")).toBe(true);
    expect(screen.queryByRole("button", { name: "もっと見る" })).toBeNull();
  });

  it("1件もないときは欄を出さない（空の案内も出さない）", async () => {
    everyoneTab({ "/api/v1/friend-wishes": empty });
    renderApp();
    await screen.findByText("まだ友達のここ暇はありません");
    expect(screen.queryByText("友達の行きたい")).toBeNull();
  });
});

describe("友達の詳細の行きたい", () => {
  const detail = (over: Routes = {}) => {
    window.history.replaceState(null, "", `/friends/${FRIEND}`);
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      [`/api/v1/friends/${FRIEND}`]: json(friend(1, "あき")),
      [`/api/v1/friends/${FRIEND}/availabilities`]: empty,
      "/api/v1/friends": json({ items: [friend(1, "あき")], nextCursor: null }),
      ...over,
    });
  };

  it("その友達の行きたいと「ここで誘う」を出す", async () => {
    detail({ [`/api/v1/friends/${FRIEND}/wishes`]: json({ items: [friendsWish()], nextCursor: null }) });
    renderApp();
    const list = await screen.findByRole("list", { name: "友達の行きたい" });
    expect(within(list).getByText("〇〇のラーメン行きたい")).toBeVisible();
    expect(within(list).getByRole("link", { name: "ここで誘う" })).toHaveAttribute("href", `/invites/new?wish=${WISH_ID}`);
  });

  it("ないときは欄を出さない", async () => {
    detail({ [`/api/v1/friends/${FRIEND}/wishes`]: empty });
    renderApp();
    await screen.findByText("見えているここ暇はありません");
    expect(screen.queryByRole("list", { name: "友達の行きたい" })).toBeNull();
  });
});

describe("作成画面の ?wish=<id>", () => {
  const me = json({ id: ME, displayName: "わたし", avatarUrl: null });

  const invitePage = (search: string, over: Routes = {}) => {
    window.history.replaceState(null, "", `/invites/new${search}`);
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": me,
      "/api/v1/friends": json({ items: [friend(1, "あき"), friend(2, "はる")], nextCursor: null }),
      "/api/v1/me/presets": presets,
      [`/api/v1/friends/${FRIEND}/availabilities`]: empty,
      [`/api/v1/friends/${uuid(2)}/availabilities`]: empty,
      ...over,
    });
  };

  it("誘い：友達の行きたいなら、宛先は持ち主で、ひとこと・エリア・リンクが入る（?friend より優先）", async () => {
    invitePage(`?wish=${WISH_ID}&friend=${uuid(2)}`, {
      [`/api/v1/wishes/${WISH_ID}`]: json(friendsWish({ url: "https://example.com/ramen" })),
    });
    renderApp();
    expect(await screen.findByDisplayValue("〇〇のラーメン行きたい")).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("相手")).toHaveValue(FRIEND));
    expect(screen.getByLabelText("エリア（任意）")).toHaveValue("渋谷");
    expect(screen.getByLabelText("リンク（任意）")).toHaveValue("https://example.com/ramen");
  });

  it("誘い：持ち主が友達の一覧の2ページ目にいても、「相手」に名前が出る", async () => {
    invitePage(`?wish=${WISH_ID}`, {
      "/api/v1/friends": [
        json({ items: [friend(2, "はる")], nextCursor: "next" }),
        json({ items: [friend(1, "あき")], nextCursor: null }),
      ],
      [`/api/v1/wishes/${WISH_ID}`]: json(friendsWish()),
    });
    renderApp();
    expect(await screen.findByDisplayValue("〇〇のラーメン行きたい")).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("相手")).toHaveValue(FRIEND));
    expect(within(screen.getByLabelText("相手")).getByRole("option", { name: "あき" })).toBeInTheDocument();
  });

  it("誘い：自分の行きたいなら、宛先は ?friend のまま", async () => {
    invitePage(`?wish=${WISH_ID}&friend=${uuid(2)}`, { [`/api/v1/wishes/${WISH_ID}`]: json(wish()) });
    renderApp();
    expect(await screen.findByDisplayValue("〇〇のラーメン行きたい")).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("相手")).toHaveValue(uuid(2)));
  });

  it("誘い：読めなかったら空で開き、エラーを出さない", async () => {
    invitePage(`?wish=${WISH_ID}`, { [`/api/v1/wishes/${WISH_ID}`]: json({ code: "not_found" }, 404) });
    renderApp();
    const message = await screen.findByLabelText("ひとこと（任意）");
    expect(message).toHaveValue("");
    expect(screen.getByLabelText("相手")).toHaveValue("");
    expect(screen.queryByText(/読み込めませんでした/)).toBeNull();
  });

  it("誘い：自分の ID が読めなければ、友達の行きたいを ?friend の宛先に入れず、空で開く", async () => {
    invitePage(`?wish=${WISH_ID}&friend=${uuid(2)}`, {
      "/api/v1/me": json({ code: "internal_error" }, 500),
      [`/api/v1/wishes/${WISH_ID}`]: json(friendsWish()),
    });
    renderApp();
    const message = await screen.findByLabelText("ひとこと（任意）");
    expect(message).toHaveValue("");
    expect(screen.queryByDisplayValue("〇〇のラーメン行きたい")).toBeNull();
  });

  const broadcastPage = (search: string, over: Routes = {}) => {
    window.history.replaceState(null, "", `/broadcasts/new${search}`);
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": me,
      "/api/v1/friends": json({ items: [friend(1), friend(2)], nextCursor: null }),
      "/api/v1/me/presets": presets,
      ...over,
    });
  };

  it("募集：自分の行きたいなら中身が入る", async () => {
    broadcastPage(`?wish=${WISH_ID}`, { [`/api/v1/wishes/${WISH_ID}`]: json(wish()) });
    renderApp();
    expect(await screen.findByDisplayValue("〇〇のラーメン行きたい")).toBeVisible();
    expect(screen.getByLabelText("エリア（任意）")).toHaveValue("渋谷");
  });

  it("募集：友達の行きたいなら何も入れない", async () => {
    broadcastPage(`?wish=${WISH_ID}`, { [`/api/v1/wishes/${WISH_ID}`]: json(friendsWish()) });
    renderApp();
    const message = await screen.findByLabelText("ひとこと（任意）");
    expect(message).toHaveValue("");
    expect(screen.getByLabelText("エリア（任意）")).toHaveValue("");
  });

  it("募集：?from（再募集）があれば ?wish は読まない", async () => {
    const BROADCAST_ID = uuid(700);
    const { calls } = broadcastPage(`?from=${BROADCAST_ID}&wish=${WISH_ID}`, {
      [`/api/v1/broadcasts/${BROADCAST_ID}`]: json({
        id: BROADCAST_ID,
        direction: "sent",
        owner: { ...profile(ME, "わたし"), withdrawn: false },
        status: "expired",
        startsAt: "2026-10-10T10:00:00.000Z",
        endsAt: "2026-10-10T14:00:00.000Z",
        area: "新宿",
        message: "前の募集",
        url: null,
        linkPreview: null,
        expiresAt: "2026-10-10T10:00:00.000Z",
        createdAt: "2026-10-09T00:00:00.000Z",
        recipients: [friend(1), friend(2)].map(({ id, displayName, avatarUrl }) => ({ id, displayName, avatarUrl, withdrawn: false })),
        responseCount: 0,
        respondedByMe: null,
        meetupId: null,
      }),
    });
    renderApp();
    expect(await screen.findByDisplayValue("前の募集")).toBeVisible();
    expect(calls.some((c) => c.url.startsWith("/api/v1/wishes"))).toBe(false);
  });
});
