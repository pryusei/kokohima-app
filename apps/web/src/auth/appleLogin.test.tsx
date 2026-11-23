import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, mockFetch, renderApp } from "../test/helpers";
import { tokenStore } from "./tokenStore";

// Sign in with Apple のボタン（docs/specs/T-12-release.md「Apple のログインを止める」）。
// ビルドのときの変数 VITE_APPLE_LOGIN_ENABLED が "1" のときだけ出す。既定は出さない

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lookupOk = json({ linkId: "33333333-3333-4333-8333-333333333333", inviter: { displayName: "あき", avatarUrl: null } });

async function loginPage() {
  window.history.replaceState(null, "", "/login");
  mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
  renderApp();
  await screen.findByRole("link", { name: "Googleでログイン" });
}

async function invitePage() {
  window.history.replaceState(null, "", "/invite#t=secret-invite-token");
  mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookupOk });
  renderApp();
  await screen.findByRole("link", { name: "Googleでログイン" });
}

const pages = { ログイン: loginPage, 招待: invitePage };

describe("Apple のログインのボタン", () => {
  for (const [name, open] of Object.entries(pages)) {
    for (const value of [undefined, "", "0", "true"]) {
      it(`${name}の画面：VITE_APPLE_LOGIN_ENABLED が ${JSON.stringify(value)} なら出さない`, async () => {
        vi.stubEnv("VITE_APPLE_LOGIN_ENABLED", value);
        await open();
        expect(screen.queryByRole("link", { name: "Appleでログイン" })).toBeNull();
      });
    }

    it(`${name}の画面："1" なら出す`, async () => {
      vi.stubEnv("VITE_APPLE_LOGIN_ENABLED", "1");
      await open();
      expect(screen.getByRole("link", { name: "Appleでログイン" })).toHaveAttribute(
        "href",
        expect.stringContaining("/api/v1/auth/apple/start"),
      );
    });
  }
});
