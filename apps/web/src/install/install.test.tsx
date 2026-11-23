import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallPage } from "../pages/InstallPage";
import { resetInstallState, startInstallListener } from "./install";

// ホーム画面に追加する案内（docs/specs/T-25-installable-pwa.md「/settings/install」「振る舞い」）

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36";

let standalone: { matches: boolean; listeners: Set<() => void> };

function stubMatchMedia() {
  standalone = { matches: false, listeners: new Set() };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(display-mode: standalone)" && standalone.matches;
    },
    addEventListener: (_: string, cb: () => void) => standalone.listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => standalone.listeners.delete(cb),
  }));
}

const userAgent = (ua: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);

function promptEvent() {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(async () => ({ outcome: "dismissed" }));
  Object.assign(event, { prompt });
  return { event, prompt };
}

beforeEach(() => {
  resetInstallState();
  stubMatchMedia();
  userAgent(ANDROID);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 起動時の登録は1回だけ（テストでは先頭で1回）
startInstallListener();

describe("アプリとして使う", () => {
  it("ホーム画面から開いているときは、静かな表示と通知の設定へのリンクだけを出す", () => {
    standalone.matches = true;
    render(<InstallPage />);
    expect(screen.getByText("ホーム画面から開いています")).toBeVisible();
    expect(screen.getByRole("link", { name: "通知の設定へ" })).toHaveAttribute("href", "/settings/notifications");
    expect(screen.queryByRole("button", { name: "ホーム画面に追加" })).toBeNull();
  });

  it("iOS の standalone（navigator.standalone）でも、ホーム画面から開いている扱いにする", () => {
    userAgent(IPHONE);
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    try {
      render(<InstallPage />);
      expect(screen.getByText("ホーム画面から開いています")).toBeVisible();
    } finally {
      Reflect.deleteProperty(navigator, "standalone");
    }
  });

  it("beforeinstallprompt を受け取るとボタンが出て、押すと prompt() を1回呼んでボタンが消える", async () => {
    const { event, prompt } = promptEvent();
    act(() => void window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    render(<InstallPage />);
    const button = screen.getByRole("button", { name: "ホーム画面に追加" });
    await userEvent.click(button);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "ホーム画面に追加" })).toBeNull();
    expect(screen.getByText("ブラウザのメニューから、ホーム画面に追加（またはインストール）できます")).toBeVisible();
  });

  it("画面を開く前に来た beforeinstallprompt も使える", () => {
    const { event } = promptEvent();
    act(() => void window.dispatchEvent(event));
    render(<InstallPage />);
    expect(screen.getByRole("button", { name: "ホーム画面に追加" })).toBeVisible();
  });

  it("prompt() が拒否されても何も出さない", async () => {
    const { event, prompt } = promptEvent();
    prompt.mockRejectedValueOnce(new Error("denied"));
    act(() => void window.dispatchEvent(event));
    render(<InstallPage />);
    await userEvent.click(screen.getByRole("button", { name: "ホーム画面に追加" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("iOS の Safari では、手順の4つを番号つきで出す", () => {
    userAgent(IPHONE);
    render(<InstallPage />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Safari で開く",
      "共有のボタンを押す",
      "「ホーム画面に追加」を選ぶ",
      "ホーム画面のアイコンから開く",
    ]);
    expect(screen.queryByRole("button", { name: "ホーム画面に追加" })).toBeNull();
  });

  it("それ以外では、一般の案内と「Safari か Chrome で開き直してください」を出す", () => {
    render(<InstallPage />);
    expect(screen.getByText("ブラウザのメニューから、ホーム画面に追加（またはインストール）できます")).toBeVisible();
    expect(screen.getByText("うまく追加できないときは、Safari か Chrome で開き直してください")).toBeVisible();
  });

  it("appinstalled を受けると「ホーム画面に追加しました」と通知の設定へのリンクを出す", () => {
    render(<InstallPage />);
    act(() => void window.dispatchEvent(new Event("appinstalled")));
    expect(screen.getByText("ホーム画面に追加しました")).toBeVisible();
    expect(screen.getByRole("link", { name: "通知の設定へ" })).toBeVisible();
  });

  it("display-mode の change で表示が切り替わる", () => {
    render(<InstallPage />);
    expect(screen.queryByText("ホーム画面から開いています")).toBeNull();
    act(() => {
      standalone.matches = true;
      for (const cb of standalone.listeners) cb();
    });
    expect(screen.getByText("ホーム画面から開いています")).toBeVisible();
  });

  it("matchMedia がない環境でも例外にならず、「それ以外」の表示になる", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<InstallPage />);
    expect(screen.getByText("うまく追加できないときは、Safari か Chrome で開き直してください")).toBeVisible();
  });

  it("どの状態でも、ブラウザに何も保存せず、エラーの表示を出さない", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookie = vi.spyOn(document, "cookie", "set");
    const { event } = promptEvent();
    act(() => void window.dispatchEvent(event));
    render(<InstallPage />);
    await userEvent.click(screen.getByRole("button", { name: "ホーム画面に追加" }));
    act(() => void window.dispatchEvent(new Event("appinstalled")));
    expect(setItem).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
