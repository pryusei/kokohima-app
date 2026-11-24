import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody, type Route } from "../test/helpers";

// 今ひま（docs/specs/T-40-ima-hima.md）
// 時計は 2026-10-10T06:20:00Z（東京は土曜 15:20）

type Routes = Record<string, Route | Route[]>;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const empty = json({ items: [], nextCursor: null });
const NOW = "2026-10-10T06:20:00Z";

const friend = (n: number, name: string) => ({
  id: uuid(n),
  displayName: name,
  avatarUrl: null,
  sharesMyAvailability: true,
  friendsSince: "2026-10-07T00:00:00.000Z",
});

const mineItem = (over: Record<string, unknown> = {}) => ({
  source: "manual",
  id: uuid(100),
  date: null,
  startsAt: "2026-10-10T06:30:00.000Z",
  endsAt: "2026-10-10T09:30:00.000Z",
  label: null,
  freeNow: true,
  ...over,
});

const friendSlot = (n: number, name: string, startsAt: string, endsAt: string) => ({
  friend: { id: uuid(n), displayName: name, avatarUrl: null },
  startsAt,
  endsAt,
  label: null,
  overlapsMine: false,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
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
    "/api/v1/friends": json({ items: [friend(1, "あき"), friend(2, "ゆう")], nextCursor: null }),
    "/api/v1/friend-availabilities": empty,
    "/api/v1/friend-wishes": empty,
    "/api/v1/availabilities": empty,
    ...over,
  });
};

/** POST で作った枠を、そのあとの GET でも返す */
const lightRoute = (created: unknown): Route => {
  let items: unknown[] = [];
  return (req) => {
    if (req.init.method !== "POST") return json({ items, nextCursor: null })();
    items = [created];
    return json(created, 201)();
  };
};

/** setTimeout・setInterval も偽にする（5秒・30秒の振る舞いを実時間を待たずに確かめる）。実時間でも少しずつ進める */
const fakeAllTimers = (at: string) => {
  vi.useRealTimers();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(at));
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
};
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** 返さない応答（通信が止まっている・送信の途中） */
const never: Route = () => new Promise<Response>(() => {});
const gets = (calls: { url: string; init: RequestInit }[]) =>
  calls.filter((c) => c.url.startsWith("/api/v1/availabilities?") && (c.init.method ?? "GET") === "GET").length;

const card = () => screen.findByRole("region", { name: "今ひま" });
const lightButton = async () => within(await card()).findByRole("button", { name: /今から3時間ひま/ });
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as unknown;
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe("灯す", () => {
  it("「みんな」の一番上に大きな灯りのボタン。押すと確認なしで今から3時間の今ひまを作り、「今ひま 〜HH:MMまで」と「やめる」になる", async () => {
    const created = mineItem();
    const { calls } = everyoneTab({
      "/api/v1/availabilities": lightRoute(created),
    });
    renderApp();
    const button = await lightButton();
    expect(button).toHaveTextContent("15:30〜18:30 ・ 押すとすぐ灯る");
    await waitFor(() => expect(button).toBeEnabled());
    // 一番上（「誰を誘う？」より前）
    const main = screen.getByRole("main");
    const regions = within(main).getAllByRole("region");
    await waitFor(() => expect(within(main).getAllByRole("region").length).toBeGreaterThan(1));
    expect(regions[0]).toHaveAccessibleName("今ひま");

    const before = calls.filter((c) => c.url.startsWith("/api/v1/friend-availabilities")).length;
    await userEvent.click(button);
    expect(await screen.findByText("今ひま 〜18:30まで")).toBeVisible();
    const lit = await card();
    expect(within(lit).getByText("見せている友達に、時刻だけ出ています。通知はしていません")).toBeVisible();
    expect(within(lit).getByRole("button", { name: "やめる" })).toBeVisible();

    const post = calls.find((c) => c.url === "/api/v1/availabilities" && c.init.method === "POST");
    expect(post && bodyOf(post.init)).toEqual({ freeNow: true });
    expect(post && headerOf(post.init, "Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    // 重なりの印のために「みんな」を取り直す
    await waitFor(() =>
      expect(calls.filter((c) => c.url.startsWith("/api/v1/friend-availabilities")).length).toBeGreaterThan(before),
    );
  });

  it("日付をまたぐとき（22:10）は 22:15〜翌01:15 のまま（24時で切らない）", async () => {
    vi.setSystemTime(new Date("2026-10-10T13:10:00Z"));
    const created = mineItem({ startsAt: "2026-10-10T13:15:00.000Z", endsAt: "2026-10-10T16:15:00.000Z" });
    everyoneTab({
      "/api/v1/availabilities": lightRoute(created),
    });
    renderApp();
    const button = await lightButton();
    expect(button).toHaveTextContent("22:15〜翌01:15");
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText("今ひま 〜翌01:15まで")).toBeVisible();
  });

  it("すでに今ひまがあれば、開いたときから「今ひま 〜HH:MMまで」。ほかの作り方の枠では灯らない", async () => {
    everyoneTab({
      "/api/v1/availabilities": json({
        items: [mineItem({ id: uuid(101), freeNow: false, startsAt: "2026-10-10T05:00:00.000Z" }), mineItem()],
        nextCursor: null,
      }),
    });
    renderApp();
    expect(await within(await card()).findByText("今ひま 〜18:30まで")).toBeVisible();
  });

  it("自分のほかのここ暇と重なる（409）：静かな文言で知らせ、ボタンは出したまま", async () => {
    everyoneTab({
      "/api/v1/availabilities": (req) =>
        req.init.method === "POST"
          ? json({ type: "about:blank", title: "Conflict", status: 409, code: "invalid_state" }, 409)()
          : empty(),
    });
    renderApp();
    const button = await lightButton();
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const text = await within(await card()).findByText("この時間には、もうほかのここ暇があります");
    expect(text.className).not.toMatch(/red|rose|danger/);
    expect(await lightButton()).toBeEnabled();
  });

  it("友達が0人なら今ひまのボタンは出さない（招待の1つのボタンだけ。T-34）", async () => {
    everyoneTab({ "/api/v1/friends": empty, "/api/v1/me": json({ id: uuid(900), displayName: "わたし", avatarUrl: null }) });
    renderApp();
    expect(await screen.findByText("まだ友達はいません")).toBeVisible();
    expect(screen.queryByRole("region", { name: "今ひま" })).toBeNull();
  });
});

describe("やめる・元に戻す・おしまい", () => {
  it("やめると、すぐ灰色の「今ひまをやめました」と「元に戻す」。元に戻すと同じ開始で作り直す", async () => {
    const item = mineItem();
    let list = [item];
    const { calls } = everyoneTab({
      "/api/v1/availabilities": (req) => {
        if (req.init.method === "POST") {
          list = [item];
          return json(item, 201)();
        }
        return json({ items: list, nextCursor: null })();
      },
      [`/api/v1/availabilities/${item.id}`]: () => {
        list = [];
        return new Response(null, { status: 204 });
      },
    });
    renderApp();
    const lit = await card();
    await userEvent.click(await within(lit).findByRole("button", { name: "やめる" }));
    const quiet = await screen.findByText("今ひまをやめました");
    expect(quiet.closest("section")?.className).toContain("bg-quiet-bg");
    expect(quiet.closest("section")?.className).not.toMatch(/red|rose|danger/);
    expect(calls.some((c) => c.url === `/api/v1/availabilities/${item.id}` && c.init.method === "DELETE")).toBe(true);

    const undo = await screen.findByRole("button", { name: "元に戻す" });
    await waitFor(() => expect(undo).toBeEnabled());
    await userEvent.click(undo);
    expect(await screen.findByText("今ひま 〜18:30まで")).toBeVisible();
    const post = calls.find((c) => c.url === "/api/v1/availabilities" && c.init.method === "POST");
    expect(post && bodyOf(post.init)).toEqual({ freeNow: true, startsAt: item.startsAt });
  });

  it("「元に戻す」は5秒で消え、灯りのボタンに戻る", async () => {
    const user = fakeAllTimers(NOW);
    const item = mineItem();
    let list = [item];
    everyoneTab({
      "/api/v1/availabilities": () => json({ items: list, nextCursor: null })(),
      [`/api/v1/availabilities/${item.id}`]: () => {
        list = [];
        return new Response(null, { status: 204 });
      },
    });
    renderApp();
    await user.click(await within(await card()).findByRole("button", { name: "やめる" }));
    expect(await screen.findByRole("button", { name: "元に戻す" })).toBeVisible();
    await advance(4_000);
    expect(screen.getByRole("button", { name: "元に戻す" })).toBeVisible();
    await advance(1_500);
    expect(screen.queryByRole("button", { name: "元に戻す" })).toBeNull();
    expect(await lightButton()).toBeVisible();
  });

  it("「元に戻す」が送信の途中なら5秒たっても消さず、その間は灯りのボタンも押せない", async () => {
    const user = fakeAllTimers(NOW);
    const item = mineItem();
    let list = [item];
    everyoneTab({
      "/api/v1/availabilities": (req) => (req.init.method === "POST" ? never(req) : json({ items: list, nextCursor: null })()),
      [`/api/v1/availabilities/${item.id}`]: () => {
        list = [];
        return new Response(null, { status: 204 });
      },
    });
    renderApp();
    await user.click(await within(await card()).findByRole("button", { name: "やめる" }));
    const undo = await screen.findByRole("button", { name: "元に戻す" });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    await advance(6_000);
    expect(screen.getByText("今ひまをやめました")).toBeVisible();
    expect(screen.getByRole("button", { name: "元に戻す" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /今から3時間ひま/ })).toBeNull();
  });

  it("元に戻せなかったら（500）、静かな「元に戻せませんでした」", async () => {
    const item = mineItem();
    let list = [item];
    everyoneTab({
      "/api/v1/availabilities": (req) =>
        req.init.method === "POST"
          ? json({ type: "about:blank", title: "Internal Server Error", status: 500 }, 500)()
          : json({ items: list, nextCursor: null })(),
      [`/api/v1/availabilities/${item.id}`]: () => {
        list = [];
        return new Response(null, { status: 204 });
      },
    });
    renderApp();
    await userEvent.click(await within(await card()).findByRole("button", { name: "やめる" }));
    const undo = await screen.findByRole("button", { name: "元に戻す" });
    await waitFor(() => expect(undo).toBeEnabled());
    await userEvent.click(undo);
    const text = await within(await card()).findByText("元に戻せませんでした");
    expect(text.className).not.toMatch(/red|rose|danger/);
  });

  it("やめる送信の途中は「元に戻す」を押せない", async () => {
    const item = mineItem();
    everyoneTab({
      "/api/v1/availabilities": json({ items: [item], nextCursor: null }),
      [`/api/v1/availabilities/${item.id}`]: never,
    });
    renderApp();
    await userEvent.click(await within(await card()).findByRole("button", { name: "やめる" }));
    expect(await screen.findByRole("button", { name: "元に戻す" })).toBeDisabled();
  });

  it("オフラインの間は、灯りのボタンも「元に戻す」も押せない", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const goOffline = () => {
      onLine.mockReturnValue(false);
      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
    };
    // TanStack Query のオンラインの判定もイベントで戻す（ほかのテストに残さない）
    const goOnline = () => {
      onLine.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
    };
    const item = mineItem();
    let list: unknown[] = [];
    everyoneTab({ "/api/v1/availabilities": () => json({ items: list, nextCursor: null })() });
    const view = renderApp();
    const button = await lightButton();
    await waitFor(() => expect(button).toBeEnabled());
    goOffline();
    expect(await lightButton()).toBeDisabled();
    // 戻してから外す（外したあとはイベントが TanStack Query に届かない）
    goOnline();
    view.unmount();

    // 今ひまがあるとき：オンラインのうちにやめ、そのあとオフラインになる
    list = [item];
    everyoneTab({
      "/api/v1/availabilities": () => json({ items: list, nextCursor: null })(),
      [`/api/v1/availabilities/${item.id}`]: () => {
        list = [];
        return new Response(null, { status: 204 });
      },
    });
    renderApp();
    await userEvent.click(await within(await card()).findByRole("button", { name: "やめる" }));
    const undo = await screen.findByRole("button", { name: "元に戻す" });
    await waitFor(() => expect(undo).toBeEnabled());
    goOffline();
    expect(screen.getByRole("button", { name: "元に戻す" })).toBeDisabled();
    goOnline();
    onLine.mockRestore();
  });

  it("やめられなかったら（500）、今ひまを元に戻して静かな文言", async () => {
    const item = mineItem();
    everyoneTab({
      "/api/v1/availabilities": json({ items: [item], nextCursor: null }),
      [`/api/v1/availabilities/${item.id}`]: json({ type: "about:blank", title: "Internal Server Error", status: 500 }, 500),
    });
    renderApp();
    await userEvent.click(await within(await card()).findByRole("button", { name: "やめる" }));
    expect(await screen.findByText("やめられませんでした。もう一度お試しください")).toBeVisible();
    expect(screen.queryByText("今ひまをやめました")).toBeNull();
    expect(screen.getByText("今ひま 〜18:30まで")).toBeVisible();
  });

  it("時間が来たら、灰色の「HH:MMで今ひまはおしまい」（赤を使わない）", async () => {
    // 1秒後に終わる今ひま（時計は止めてあるので、終わりの時刻はタイマーで知る）
    const item = mineItem({ startsAt: "2026-10-10T03:30:00.000Z", endsAt: new Date(Date.now() + 1000).toISOString() });
    everyoneTab({ "/api/v1/availabilities": json({ items: [item], nextCursor: null }) });
    renderApp();
    expect(await within(await card()).findByText("今ひま 〜15:20まで")).toBeVisible();
    const ended = await screen.findByText("15:20で今ひまはおしまい", undefined, { timeout: 3000 });
    expect(ended.closest("section")?.className).toContain("bg-quiet-bg");
    expect(ended.closest("section")?.className).not.toMatch(/red|rose|danger/);
  });

  it("「おしまい」は5秒で消え、取り直して灯りのボタンに戻る。サーバーがまだ終わった枠を返しても灯った表示に戻さない", async () => {
    fakeAllTimers(NOW);
    const item = mineItem({ startsAt: "2026-10-10T03:30:00.000Z", endsAt: new Date(Date.now() + 1000).toISOString() });
    // 端末の時計が進んでいるなどで、取り直してもまだ同じ枠が返る
    const { calls } = everyoneTab({ "/api/v1/availabilities": json({ items: [item], nextCursor: null }) });
    renderApp();
    expect(await within(await card()).findByText("今ひま 〜15:20まで")).toBeVisible();
    const before = gets(calls);
    await advance(1_000);
    expect(await screen.findByText("15:20で今ひまはおしまい")).toBeVisible();
    await waitFor(() => expect(gets(calls)).toBeGreaterThan(before));
    await advance(5_000);
    expect(screen.queryByText("15:20で今ひまはおしまい")).toBeNull();
    expect(await lightButton()).toBeVisible();
    // 30秒の描き直しのあとも、終わった今ひまを灯った表示に戻さない
    await advance(30_000);
    expect(screen.queryByText(/今ひま 〜/)).toBeNull();
    expect(screen.queryByText(/おしまい/)).toBeNull();
    expect(await lightButton()).toBeVisible();
  });
});

describe("日付をまたぐ今ひま", () => {
  it("0:00 を過ぎても今ひまは消えない（取り直しが返らなくても）。過ぎたら「翌」を付けない", async () => {
    fakeAllTimers("2026-10-10T14:59:50Z"); // 東京 23:59:50
    const item = mineItem({ startsAt: "2026-10-10T13:15:00.000Z", endsAt: "2026-10-10T16:15:00.000Z" });
    everyoneTab({
      // 開いたときの日付（10/10）の一覧だけ返し、ほかの日付の取得は返さない（オフラインで止まっているのと同じ）
      "/api/v1/availabilities": (req) =>
        req.url.includes(encodeURIComponent("2026-10-09T15:00:00.000Z")) ? json({ items: [item], nextCursor: null })() : never(req),
    });
    renderApp();
    expect(await within(await card()).findByText("今ひま 〜翌01:15まで")).toBeVisible();
    await advance(30_000); // 東京 0:00:20
    expect(within(await card()).getByText("今ひま 〜01:15まで")).toBeVisible();
    expect(within(await card()).getByRole("button", { name: "やめる" })).toBeVisible();
  });

  it("0:00 を過ぎてから開いたときも「翌」を付けない（00:30 に 〜01:15）", async () => {
    vi.setSystemTime(new Date("2026-10-10T15:30:00Z")); // 東京 10/11 0:30
    const item = mineItem({ startsAt: "2026-10-10T13:15:00.000Z", endsAt: "2026-10-10T16:15:00.000Z" });
    everyoneTab({ "/api/v1/availabilities": json({ items: [item], nextCursor: null }) });
    renderApp();
    expect(await within(await card()).findByText("今ひま 〜01:15まで")).toBeVisible();
  });
});

describe("友達の一覧の「今」の印", () => {
  it("今かかっている枠と、今を15分で切り上げた時刻に始まる枠にだけ付け、先の枠には付けない", async () => {
    everyoneTab({
      "/api/v1/friends": json({ items: [friend(1, "あき"), friend(2, "ゆう"), friend(3, "そら")], nextCursor: null }),
      "/api/v1/friend-availabilities": json({
        items: [
          friendSlot(3, "そら", "2026-10-10T05:00:00.000Z", "2026-10-10T08:00:00.000Z"), // 14:00〜17:00（今かかっている）
          friendSlot(1, "あき", "2026-10-10T06:30:00.000Z", "2026-10-10T09:30:00.000Z"), // 15:30〜18:30（今ひま）
          friendSlot(2, "ゆう", "2026-10-10T07:00:00.000Z", "2026-10-10T10:00:00.000Z"), // 16:00〜19:00（先）
        ],
        nextCursor: null,
      }),
    });
    renderApp();
    const list = await screen.findByRole("region", { name: "みんなのここ暇" });
    const row = (name: string) => within(list).getAllByRole("listitem").find((li) => li.textContent?.includes(name)) as HTMLElement;
    await within(list).findByText("15:30〜18:30");
    expect(within(row("あき")).getByText("今")).toBeVisible();
    expect(within(row("そら")).getByText("今")).toBeVisible();
    expect(within(row("ゆう")).queryByText("今")).toBeNull();
    // 読み上げは「今ひま」。印は灯りの色（赤を使わない）
    expect(within(row("あき")).getByText("今").textContent).toBe("今ひま");
    expect(within(row("あき")).getByText("今").className).toContain("bg-lamp");
  });

  it("30秒ごとに描き直し、「今」の印と灯りのボタンの目安の時刻が変わる（API は呼ばない）", async () => {
    fakeAllTimers("2026-10-10T06:29:50Z"); // 東京 15:29:50
    const { calls } = everyoneTab({
      "/api/v1/friend-availabilities": json({
        items: [friendSlot(2, "ゆう", "2026-10-10T06:45:00.000Z", "2026-10-10T09:45:00.000Z")], // 15:45〜18:45
        nextCursor: null,
      }),
    });
    renderApp();
    const list = await screen.findByRole("region", { name: "みんなのここ暇" });
    await within(list).findByText("15:45〜18:45");
    expect(within(list).queryByText("今")).toBeNull();
    expect(await lightButton()).toHaveTextContent("15:30〜18:30");
    const before = calls.length;
    await advance(30_000); // 15:30:20 → 切り上げると 15:45
    expect(within(list).getByText("今")).toBeVisible();
    expect(await lightButton()).toHaveTextContent("15:45〜18:45");
    expect(calls.length).toBe(before);
  });
});
