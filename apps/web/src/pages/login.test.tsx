import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp } from "../test/helpers";

// ログインの画面の文言（利用者と決めた：カレンダーについての1行は出さない）

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ログインの画面", () => {
  it("Google のログインのボタンを出し、カレンダーについての1行は出さない", async () => {
    window.history.replaceState(null, "", "/login");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
    expect(screen.queryByText(/連携するまで読みません/)).toBeNull();
    // LINE以外では、開き直す帯を出さない（T-28）
    expect(screen.queryByRole("link", { name: "ブラウザで開き直す" })).toBeNull();
  });

  it("LINEのアプリ内ブラウザでは、今のURLに openExternalBrowser=1 を足した「ブラウザで開き直す」を出す（T-28）", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 Line/15.2.1/IAB",
    );
    window.history.replaceState(null, "", "/login?returnTo=%2Ffriends");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    expect(await screen.findByRole("link", { name: "ブラウザで開き直す" })).toHaveAttribute(
      "href",
      "/login?returnTo=%2Ffriends&openExternalBrowser=1",
    );
    expect(screen.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
  });
});
