import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

// 時計は 2026-10-10T00:00:00Z（東京は土曜 09:00）
const ID = "77777777-7777-4777-8777-777777777777";
const MEETUP_ID = "66666666-6666-4666-8666-666666666666";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const friend = (n: number, name = `友${n}`) => ({
  id: uuid(n),
  displayName: name,
  avatarUrl: null,
  sharesMyAvailability: true,
  friendsSince: "2026-10-07T00:00:00.000Z",
});
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
});
const broadcast = (over: Record<string, unknown> = {}) => ({
  id: ID,
  direction: "sent",
  owner: { id: uuid(999), displayName: "あき", avatarUrl: null },
  status: "open",
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  area: "渋谷",
  message: null,
  url: null,
  expiresAt: "2026-10-10T10:00:00.000Z",
  createdAt: "2026-10-10T00:00:00.000Z",
  recipients: [friend(1), friend(2)].map(({ id, displayName, avatarUrl }) => ({ id, displayName, avatarUrl })),
  responseCount: 0,
  respondedByMe: null,
  meetupId: null,
  ...over,
});
const received = (over: Record<string, unknown> = {}) =>
  broadcast({ direction: "received", recipients: null, responseCount: null, respondedByMe: false, ...over });

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

const newPage = (search: string, friends: unknown[], over: Parameters<typeof mockFetch>[0] = {}) => {
  window.history.replaceState(null, "", `/broadcasts/new${search}`);
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/friends": json({ items: friends, nextCursor: null }),
    "/api/v1/me/presets": presets,
    ...over,
  });
};

describe("募集の作成", () => {
  it("宛先の初期値は友達全員。送ると詳細へ移る", async () => {
    const { calls } = newPage("", [friend(1), friend(2), friend(3)], {
      "/api/v1/broadcasts": json(broadcast(), 201),
      [`/api/v1/broadcasts/${ID}`]: json(broadcast()),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "宛先" });
    expect(within(list).getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(within(list).getByLabelText("友3"));
    await userEvent.click(screen.getByRole("button", { name: "募集する" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/broadcasts/${ID}`));
    const post = calls.find((c) => c.url === "/api/v1/broadcasts" && c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toMatchObject({
      recipientIds: [uuid(1), uuid(2)],
      startsAt: "2026-10-10T01:15:00.000Z",
      endsAt: "2026-10-10T03:15:00.000Z",
      expiresIn: "until_start",
    });
  });

  it("1人以下では送れず、100人を超える友達がいるときは100人まで選んだ状態で開く", async () => {
    const many = Array.from({ length: 101 }, (_, i) => friend(i + 1));
    newPage("", many);
    renderApp();
    expect(await screen.findByText("一度に送れるのは100人までです")).toBeVisible();
    expect(screen.getByText("宛先（100人）")).toBeVisible();
    expect(screen.getByLabelText("友101")).not.toBeChecked();
  });

  it("宛先が1人だと送れない", async () => {
    newPage("", [friend(1), friend(2)]);
    renderApp();
    await userEvent.click(await screen.findByLabelText("友2"));
    expect(screen.getByRole("button", { name: "募集する" })).toBeDisabled();
    expect(screen.getByText(/2人以上を選んでください/)).toBeVisible();
  });

  it("送れなかったとき（404）は静かな文言", async () => {
    newPage("", [friend(1), friend(2)], { "/api/v1/broadcasts": json({}, 404) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "募集する" }));
    const message = await screen.findByText(/送れない友達が含まれていました/);
    expect(message.className).not.toMatch(/red|rose/);
  });

  it("もう一度募集する：元の宛先のうち今も友達の人と内容が入り、過ぎた時間は空になる", async () => {
    const past = broadcast({
      status: "expired",
      startsAt: "2026-10-09T10:00:00.000Z",
      endsAt: "2026-10-09T12:00:00.000Z",
      message: "ごはん",
      recipients: [friend(1), friend(5)].map(({ id, displayName, avatarUrl }) => ({ id, displayName, avatarUrl })),
    });
    newPage(`?from=${ID}`, [friend(1), friend(2)], { [`/api/v1/broadcasts/${ID}`]: json(past) });
    renderApp();
    expect(await screen.findByLabelText("友1")).toBeChecked();
    expect(screen.getByLabelText("友2")).not.toBeChecked();
    expect(screen.getByLabelText("エリア（任意）")).toHaveValue("渋谷");
    expect(screen.getByLabelText("ひとこと（任意）")).toHaveValue("ごはん");
    expect(screen.getByLabelText("開始", { exact: true })).toHaveValue("");
  });
});

describe("募集の詳細", () => {
  const detail = (routes: Parameters<typeof mockFetch>[0]) => {
    window.history.replaceState(null, "", `/broadcasts/${ID}`);
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/broadcasts": json({ items: [], nextCursor: null }),
      "/api/v1/meetups": json({ items: [], nextCursor: null }),
      ...routes,
    });
  };

  it("募集者には人数だけを出し、1人以上なら「決める」。決めたら予定へのリンク", async () => {
    const { calls } = detail({
      [`/api/v1/broadcasts/${ID}`]: [
        json(broadcast({ responseCount: 2 })),
        json(broadcast({ status: "decided", responseCount: 2, meetupId: MEETUP_ID })),
      ],
      [`/api/v1/broadcasts/${ID}/decide`]: json(broadcast({ status: "decided", responseCount: 2, meetupId: MEETUP_ID })),
    });
    renderApp();
    expect(await screen.findByText("2人が応じています")).toBeVisible();
    expect(screen.queryByText("友1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "決める" }));
    expect(await screen.findByRole("link", { name: "成立した予定を見る" })).toHaveAttribute("href", `/meetups/${MEETUP_ID}`);
    expect(calls.some((c) => c.url.endsWith("/decide"))).toBe(true);
  });

  it("応じた人が0人なら「決める」を出さず、期限切れなら「もう一度募集する」", async () => {
    detail({ [`/api/v1/broadcasts/${ID}`]: json(broadcast({ status: "expired" })) });
    renderApp();
    expect(await screen.findByText("期限が過ぎました")).toBeVisible();
    expect(screen.queryByRole("button", { name: "決める" })).toBeNull();
    expect(screen.getByRole("link", { name: "もう一度募集する" })).toHaveAttribute("href", `/broadcasts/new?from=${ID}`);
  });

  it("宛先の人には人数を出さず、「応じる」で応じたことだけを出す", async () => {
    const { calls } = detail({
      [`/api/v1/broadcasts/${ID}`]: [json(received()), json(received({ respondedByMe: true }))],
      [`/api/v1/broadcasts/${ID}/responses`]: json(received({ respondedByMe: true })),
    });
    renderApp();
    expect(await screen.findByText("募集中")).toBeVisible();
    expect(screen.queryByText(/人が応じています/)).toBeNull();
    expect(screen.getByText("あき")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "応じる" }));
    expect(await screen.findByRole("button", { name: "応じるのをやめる" })).toBeVisible();
    expect(screen.getByText("応じました")).toBeVisible();
    expect(calls.find((c) => c.url.endsWith("/responses"))?.init.method).toBe("POST");
  });

  it("締め切りましたは静かな灰色。409 なら読み直して静かな文言を出す", async () => {
    detail({
      [`/api/v1/broadcasts/${ID}`]: [json(received()), json(received({ status: "closed" }))],
      [`/api/v1/broadcasts/${ID}/responses`]: json({ code: "expired" }, 409),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "応じる" }));
    expect(await screen.findByText("状態が変わっていました。最新の状態を表示しました")).toBeVisible();
    const closed = await screen.findByText("締め切りました");
    expect(closed.className).not.toMatch(/red|rose/);
    expect(screen.queryByRole("button", { name: "応じる" })).toBeNull();
  });
});
