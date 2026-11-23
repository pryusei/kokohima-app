import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp } from "../test/helpers";

// ログインの画面の文言（利用者と決めた：カレンダーについての1行は出さない）

beforeEach(() => {
  tokenStore.clear();
});

describe("ログインの画面", () => {
  it("Google のログインのボタンを出し、カレンダーについての1行は出さない", async () => {
    window.history.replaceState(null, "", "/login");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
    expect(screen.queryByText(/連携するまで読みません/)).toBeNull();
  });
});
