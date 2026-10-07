import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError, setUnauthenticatedHandler } from "../api/client";
import { readAndClearCode } from "../pages/AuthCompletePage";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { tokenStore } from "./tokenStore";

const me = { id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName: null, avatarUrl: null };

beforeEach(() => {
  tokenStore.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("APIクライアント", () => {
  it("401を受けたら1回だけ更新して再送する", async () => {
    tokenStore.set("old", new Date(Date.now() + 60_000).toISOString());
    const { calls } = mockFetch({
      "/api/v1/me": [json({}, 401), json(me)],
      "/api/v1/auth/refresh": json(tokenBody("new")),
    });
    const res = await apiFetch("/api/v1/me");
    expect(res.status).toBe(200);
    const meCalls = calls.filter((c) => c.url === "/api/v1/me");
    expect(new Headers(meCalls[1]?.init.headers).get("Authorization")).toBe("Bearer new");
    expect(calls.filter((c) => c.url === "/api/v1/auth/refresh")).toHaveLength(1);
  });

  it("更新も401ならログアウト状態にする（2回目の401）", async () => {
    tokenStore.set("old", new Date(Date.now() + 60_000).toISOString());
    mockFetch({ "/api/v1/me": json({}, 401), "/api/v1/auth/refresh": json({}, 401) });
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    await expect(apiFetch("/api/v1/me")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledOnce();
    expect(tokenStore.get()).toBeNull();
  });

  it("トークンがなく、最初の更新が401なら、本来のリクエストを送らずにログアウト状態にする", async () => {
    const { calls } = mockFetch({ "/api/v1/me": json(me), "/api/v1/auth/refresh": json({}, 401) });
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    await expect(apiFetch("/api/v1/me")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/auth/refresh"]);
  });

  it("再送しても401なら、それ以上は再送しない", async () => {
    tokenStore.set("old", new Date(Date.now() + 60_000).toISOString());
    const { calls } = mockFetch({ "/api/v1/me": json({}, 401), "/api/v1/auth/refresh": json(tokenBody("new")) });
    setUnauthenticatedHandler(() => {});
    await expect(apiFetch("/api/v1/me")).rejects.toBeInstanceOf(ApiError);
    expect(calls.filter((c) => c.url === "/api/v1/me")).toHaveLength(2);
  });
});

describe("起動時のログイン状態", () => {
  it("更新に成功したら「ログイン中」。アクセストークンを localStorage・sessionStorage に保存しない", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    mockFetch({ "/api/v1/auth/refresh": json(tokenBody("secret-token")), "/api/v1/me": json(me) });
    renderApp();
    expect(await screen.findByText("ログイン中")).toBeVisible();
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain("secret-token");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("secret-token");
  });

  it("更新が401ならログイン画面へ", async () => {
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
    expect(window.location.pathname).toBe("/login");
  });

  it.each([
    ["ネットワークエラー", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["5xx", json({}, 503)],
  ])("%s ではログアウトにしない", async (_label, route) => {
    mockFetch({ "/api/v1/auth/refresh": route as never });
    renderApp();
    expect(await screen.findByText(/接続できませんでした/)).toBeVisible();
    expect(window.location.pathname).toBe("/");
  });

  it("未ログインで開いたページは returnTo に入れてログイン画面へ", async () => {
    window.history.replaceState(null, "", "/invite/abc");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("link", { name: "Googleでログイン" });
    expect(screen.getByRole("link", { name: "Googleでログイン" })).toHaveAttribute(
      "href",
      "/api/v1/auth/google/start?returnTo=%2Finvite%2Fabc",
    );
  });

  it("ログアウトするとログイン画面になる", async () => {
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(me),
      "/api/v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "ログアウト" }));
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
    expect(calls.some((c) => c.url === "/api/v1/auth/logout")).toBe(true);
    expect(tokenStore.get()).toBeNull();
  });
});

describe("ログアウトの失敗", () => {
  it("全端末ログアウト：アクセストークンが切れていれば更新してから送る", async () => {
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody("fresh")),
      "/api/v1/me": json(me),
      "/api/v1/auth/logout-all": () => new Response(null, { status: 204 }),
    });
    renderApp();
    await screen.findByText("ログイン中");
    tokenStore.set("expired", new Date(Date.now() - 1000).toISOString());
    await userEvent.click(screen.getByRole("button", { name: "すべての端末からログアウト" }));
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
    const call = calls.find((c) => c.url === "/api/v1/auth/logout-all");
    expect(new Headers(call?.init.headers).get("Authorization")).toBe("Bearer fresh");
  });

  it.each([
    ["全端末ログアウト", "すべての端末からログアウト", "/api/v1/auth/logout-all"],
    ["ログアウト", "ログアウト", "/api/v1/auth/logout"],
  ])("%s：通信できなければログイン中のまま、静かに再試行を促す", async (_l, name, path) => {
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(me),
      [path]: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    renderApp();
    await screen.findByText("ログイン中");
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}$`) }));
    expect(await screen.findByText(/ログアウトできませんでした/)).toBeVisible();
    expect(screen.getByText("ログイン中")).toBeVisible();
  });

  it("APIクライアント：更新が通信エラー・5xxならログアウトにしない", async () => {
    tokenStore.set("old", new Date(Date.now() + 60_000).toISOString());
    mockFetch({ "/api/v1/me": json({}, 401), "/api/v1/auth/refresh": json({}, 503) });
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    await expect(apiFetch("/api/v1/me")).rejects.toMatchObject({ status: 0 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("ログインの完了", () => {
  it("フラグメントのコードを読んだらすぐURLから消す", () => {
    window.history.replaceState(null, "", "/auth/complete#code=abc");
    expect(readAndClearCode()).toBe("abc");
    expect(window.location.hash).toBe("");
  });

  it("完了したら returnTo へ移り、ログイン中になる", async () => {
    window.history.replaceState(null, "", "/auth/complete#code=abc");
    const { calls } = mockFetch({
      "/api/v1/auth/complete": json({ ...tokenBody(), returnTo: "/" }),
      "/api/v1/me": json(me),
    });
    renderApp();
    expect(await screen.findByText("ログイン中")).toBeVisible();
    expect(window.location.pathname).toBe("/");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: "abc" });
  });

  it("失敗したら静かな文言でログイン画面に戻る", async () => {
    window.history.replaceState(null, "", "/auth/complete#code=abc");
    mockFetch({ "/api/v1/auth/complete": json({}, 401) });
    renderApp();
    expect(await screen.findByText(/ログインできませんでした/)).toBeVisible();
  });
});
