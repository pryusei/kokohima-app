import { describe, expect, it } from "vitest";
import { isLineInAppBrowser, lineShareHref, withOpenExternalBrowser } from "./line";

// docs/specs/T-28-line-share.md「テスト計画」

const LINE_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.2.0";
const LINE_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 Line/15.2.1/IAB";
const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0";

describe("withOpenExternalBrowser", () => {
  it("フラグメントの前に openExternalBrowser=1 を入れ、トークンはそのまま", () => {
    expect(withOpenExternalBrowser("https://example.test/invite#t=abc")).toBe(
      "https://example.test/invite?openExternalBrowser=1#t=abc",
    );
  });

  it("すでにあるクエリを壊さない", () => {
    expect(withOpenExternalBrowser("https://example.test/login?returnTo=%2Finvite")).toBe(
      "https://example.test/login?returnTo=%2Finvite&openExternalBrowser=1",
    );
  });

  it("相対のURLは相対のまま返す", () => {
    expect(withOpenExternalBrowser("/invite#t=abc")).toBe("/invite?openExternalBrowser=1#t=abc");
  });
});

describe("lineShareHref", () => {
  it("line.me の共有のURLで、本文は固定の文と openExternalBrowser 付きの招待リンクの2行", () => {
    const href = lineShareHref("https://example.test/invite#t=abc");
    expect(href.startsWith("https://line.me/R/share?text=")).toBe(true);
    const text = decodeURIComponent(href.slice("https://line.me/R/share?text=".length));
    expect(text.split("\n")).toEqual(["ここ暇で友達になろう", "https://example.test/invite?openExternalBrowser=1#t=abc"]);
  });
});

describe("isLineInAppBrowser", () => {
  it.each([LINE_IOS, LINE_ANDROID])("LINEのアプリ内ブラウザなら真", (ua) => {
    expect(isLineInAppBrowser(ua)).toBe(true);
  });

  it.each([SAFARI, CHROME, INSTAGRAM, "Mozilla/5.0 Line"])("LINE以外なら偽（%#）", (ua) => {
    expect(isLineInAppBrowser(ua)).toBe(false);
  });
});
