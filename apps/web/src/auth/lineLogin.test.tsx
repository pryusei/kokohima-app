import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, mockFetch, renderApp } from "../test/helpers";
import { tokenStore } from "./tokenStore";

// LINE ログインのボタン（docs/specs/T-32-line-login.md「6. 画面」）。ログインの画面と招待の受け口で、LINE を最初に置く

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const LINE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.2.1";
const lookupOk = json({ linkId: "33333333-3333-4333-8333-333333333333", inviter: { displayName: "あき", avatarUrl: null } });

async function loginPage(search = "") {
  window.history.replaceState(null, "", `/login${search}`);
  mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
  renderApp();
  await screen.findByRole("link", { name: "LINEでログイン" });
}

async function invitePage() {
  window.history.replaceState(null, "", "/invite#t=secret-invite-token");
  mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookupOk });
  renderApp();
  await screen.findByRole("link", { name: "LINEでログイン" });
}

const loginLinks = () => screen.getAllByRole("link").filter((a) => /でログイン$/.test(a.textContent ?? ""));

describe("LINE のログインのボタン", () => {
  it("ログインの画面：LINE が最初、Google が次。returnTo を引き継ぐ", async () => {
    await loginPage("?returnTo=%2Ffriends");
    expect(loginLinks().map((a) => a.textContent)).toEqual(["LINEでログイン", "Googleでログイン"]);
    expect(screen.getByRole("link", { name: "LINEでログイン" })).toHaveAttribute("href", "/api/v1/auth/line/start?returnTo=%2Ffriends");
  });

  it("招待の受け口：LINE が最初で、ログインのあとは受け口に戻る", async () => {
    await invitePage();
    expect(loginLinks().map((a) => a.textContent)).toEqual(["LINEでログイン", "Googleでログイン"]);
    expect(screen.getByRole("link", { name: "LINEでログイン" })).toHaveAttribute("href", "/api/v1/auth/line/start?returnTo=%2Finvite");
  });

  it("Apple を出す設定でも、LINE が最初", async () => {
    vi.stubEnv("VITE_APPLE_LOGIN_ENABLED", "1");
    await loginPage();
    expect(loginLinks().map((a) => a.textContent)).toEqual(["LINEでログイン", "Googleでログイン", "Appleでログイン"]);
  });

  it("LINE の色はトークン（brand-line）で、Tailwind の既定の緑を使わない", async () => {
    await loginPage();
    const line = screen.getByRole("link", { name: "LINEでログイン" });
    expect(line.className).toMatch(/\bbg-brand-line\b/);
    expect(line.className).toMatch(/\btext-on-brand-line\b/);
    expect(line.className).not.toMatch(/green|emerald/);
  });

  // Tailwind v4 は同じ性質のクラスをクラス名の順に出すため、副ボタンの色（bg-surface・text-ink）が残ると緑の地が白に負ける
  it("LINE と Apple のボタンに、副ボタンの色のクラスが混ざらない", async () => {
    vi.stubEnv("VITE_APPLE_LOGIN_ENABLED", "1");
    await loginPage();
    for (const name of ["LINEでログイン", "Appleでログイン"]) {
      const classes = screen.getByRole("link", { name }).className.split(/\s+/);
      expect(classes).not.toContain("bg-surface");
      expect(classes).not.toContain("text-ink");
      expect(classes).not.toContain("border-line-strong");
    }
    const apple = screen.getByRole("link", { name: "Appleでログイン" }).className.split(/\s+/);
    expect(apple).toEqual(expect.arrayContaining(["bg-ink", "text-surface"]));
  });

  it("LINE の中のブラウザ：帯は「LINEでログイン」ならこのまま続けられると伝え、開き直しは副ボタンにする", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINE_UA);
    await loginPage();
    const notice = screen.getByRole("region", { name: "ブラウザで開き直す" });
    expect(within(notice).getByText(/「LINEでログイン」なら、このまま続けられます/)).toBeVisible();
    expect(within(notice).getByRole("link", { name: "ブラウザで開き直す" }).className).not.toMatch(/\bbg-action\b/);
    expect(screen.getByRole("link", { name: "LINEでログイン" })).toBeVisible();
  });
});
