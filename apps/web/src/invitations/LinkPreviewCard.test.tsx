import type { LinkPreview } from "@kokohima/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkPreviewCard } from "./LinkPreviewCard";

// リンクのプレビューの表示（docs/specs/T-08-link-preview.md「画面（仮）」）

const ok = (p: Partial<LinkPreview> = {}): LinkPreview => ({
  status: "ok",
  title: "お店の名前",
  description: "駅から3分",
  siteName: "グルメサイト",
  imageUrl: "/api/v1/link-previews/images/11111111-1111-4111-8111-111111111111",
  ...p,
});
const empty = (status: "pending" | "failed"): LinkPreview => ({ status, title: null, description: null, siteName: null, imageUrl: null });

describe("リンクのプレビュー", () => {
  it("ok はカード：画像・タイトル・説明・ドメイン。カード全体が今と同じリンク", () => {
    const { container } = render(<LinkPreviewCard url="https://example.com/shop" preview={ok()} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com/shop");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getByText("お店の名前")).toBeVisible();
    expect(screen.getByText("駅から3分")).toBeVisible();
    expect(screen.getByText("example.com")).toBeVisible();
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", ok().imageUrl);
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(img).toHaveAttribute("alt", "");
  });

  it("ドメインは punycode で出し、siteName で置き換えない", () => {
    render(<LinkPreviewCard url="https://аpple.com/x" preview={ok({ siteName: "Apple" })} />);
    expect(screen.getByText("xn--pple-43d.com")).toBeVisible();
    expect(screen.queryByText("Apple")).toBeNull();
  });

  it("タイトル・説明は HTML として解釈しない", () => {
    const { container } = render(<LinkPreviewCard url="https://example.com/" preview={ok({ title: "<b>太字</b>", description: "<img src=x onerror=alert(1)>", imageUrl: null })} />);
    expect(screen.getByText("<b>太字</b>")).toBeVisible();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("pending・failed・null はドメインだけ。「読み込み中」は出さない", () => {
    for (const preview of [empty("pending"), empty("failed"), null]) {
      const { container, unmount } = render(<LinkPreviewCard url="https://example.com/a" preview={preview} />);
      expect(screen.getByRole("link", { name: "example.com" })).toHaveAttribute("rel", "noopener noreferrer nofollow");
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toBe("example.com");
      unmount();
    }
  });

  it("リンクがなければ何も出さない", () => {
    const { container } = render(<LinkPreviewCard url={null} preview={null} />);
    expect(container.textContent).toBe("");
  });
});
