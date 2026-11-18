import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody, type Route } from "../test/helpers";

// Idempotency-Key の付け方（docs/specs/T-10-idempotency-cache-ratelimit.md「Web」）。時計は 2026-10-10T00:00:00Z

const FRIEND_ID = "22222222-2222-4222-8222-222222222222";
const friend = { id: FRIEND_ID, displayName: "あき", avatarUrl: null };
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

const problem = (status: number, code: string) => json({ type: "about:blank", title: "x", status, code, requestId: "r" }, status);
const offline: Route = () => {
  throw new TypeError("Failed to fetch");
};

function newInvite(responses: Route[]) {
  window.history.replaceState(null, "", `/invites/new?friend=${FRIEND_ID}`);
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/friends": json({
      items: [{ ...friend, sharesMyAvailability: true, friendsSince: "2026-10-07T00:00:00.000Z" }],
      nextCursor: null,
    }),
    "/api/v1/me/presets": presets,
    [`/api/v1/friends/${FRIEND_ID}/availabilities`]: json({ items: [], nextCursor: null }),
    "/api/v1/direct-invites": responses,
  });
}

const keysSent = (calls: { url: string; init: RequestInit }[]) =>
  calls
    .filter((c) => c.url === "/api/v1/direct-invites" && c.init.method === "POST")
    .map((c) => new Headers(c.init.headers).get("Idempotency-Key"));

async function send() {
  await userEvent.click(screen.getByRole("button", { name: "誘う" }));
}

describe("誘いの作成の Idempotency-Key", () => {
  it("通信できなかった・5xx のあとに同じ内容で押し直すと同じキー。4xx のあとと内容を変えたあとは新しいキー", async () => {
    const { calls } = newInvite([offline, problem(503, "internal_error"), problem(404, "not_found"), problem(404, "not_found"), problem(404, "not_found")]);
    renderApp();
    await screen.findByText("ここどう？");
    await send();
    await screen.findByText("送れませんでした。通信状態を確認して、もう一度お試しください");
    await send();
    await waitFor(() => expect(keysSent(calls)).toHaveLength(2));
    await send();
    await waitFor(() => expect(keysSent(calls)).toHaveLength(3));
    await send();
    await waitFor(() => expect(keysSent(calls)).toHaveLength(4));
    await userEvent.type(screen.getByLabelText("ひとこと（任意）"), "やあ");
    await send();
    await waitFor(() => expect(keysSent(calls)).toHaveLength(5));
    const [k1, k2, k3, k4, k5] = keysSent(calls);
    expect(k1).toMatch(/^[0-9a-f-]{36}$/);
    // 1回目（通信できない）→2回目（503）→3回目は同じキー
    expect(k2).toBe(k1);
    expect(k3).toBe(k1);
    // 3回目が404（4xx）だったので、4回目は新しいキー
    expect(k4).not.toBe(k1);
    // 内容を変えたら新しいキー
    expect(k5).not.toBe(k4);
  });

  it("401 のあとの1回だけの送り直しでも、同じキーを使う", async () => {
    let posts = 0;
    const { calls } = newInvite([
      () => {
        posts++;
        return new Response(null, { status: 401 });
      },
      json({}, 404),
    ]);
    renderApp();
    await screen.findByText("ここどう？");
    await send();
    await waitFor(() => expect(keysSent(calls)).toHaveLength(2));
    const [first, retried] = keysSent(calls);
    expect(posts).toBe(1);
    expect(retried).toBe(first);
  });

  it("409 request_in_progress・422 は「送信できませんでした」。409 invalid_state の今の文言は変わらない", async () => {
    newInvite([problem(409, "request_in_progress"), problem(422, "idempotency_key_mismatch"), problem(409, "invalid_state")]);
    renderApp();
    await screen.findByText("ここどう？");
    await send();
    const first = await screen.findByText("送信できませんでした。もう一度お試しください");
    expect(first.className).not.toMatch(/red|rose/);
    await send();
    expect(await screen.findByText("送信できませんでした。もう一度お試しください")).toBeVisible();
    await send();
    expect(await screen.findByText("同じ時間の誘いをもう送っています")).toBeVisible();
  });
});

describe("ほかの操作の Idempotency-Key", () => {
  it("ここ暇の作成：成功したあとは、同じ内容でも新しいキー", async () => {
    window.history.replaceState(null, "", "/availability");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me/presets": presets,
      "/api/v1/availabilities": ({ init }) =>
        init.method === "POST"
          ? json({ id: crypto.randomUUID(), startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z", label: "night", source: "manual", date: null }, 201)()
          : json({ items: [], nextCursor: null })(),
      "/api/v1/recurrence-rules": json({ items: [], nextCursor: null }),
      "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
    });
    renderApp();
    const night = await screen.findByRole("button", { name: /^夜$/ });
    await userEvent.click(night);
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/v1/availabilities" && c.init.method === "POST")).toHaveLength(1));
    await userEvent.click(night);
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/v1/availabilities" && c.init.method === "POST")).toHaveLength(2));
    const [k1, k2] = calls
      .filter((c) => c.url === "/api/v1/availabilities" && c.init.method === "POST")
      .map((c) => new Headers(c.init.headers).get("Idempotency-Key"));
    expect(k1).toMatch(/^[0-9a-f-]{36}$/);
    expect(k2).toMatch(/^[0-9a-f-]{36}$/);
    expect(k2).not.toBe(k1);
  });
});
