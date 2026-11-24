import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState, FadeIn, Loading, OfflineBanner } from "./feedback";

// 読み込み中・空の状態・オフラインの帯の動き（docs/specs/T-56-motion.md「M-06」「M-19」「V-2」、テスト計画「実装PR③」）

// CSS の ?raw は vitest では空になるので、ファイルを直接読む
const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

/** index.css の `selector {…}` の中身（最初の1つ） */
const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** オンラインかどうかを切り替える（useOnline は navigator.onLine と online・offline のイベント） */
function network() {
  const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  return (online: boolean) => {
    onLine.mockReturnValue(online);
    act(() => window.dispatchEvent(new Event(online ? "online" : "offline")));
  };
}

describe("Loading（M-06）", () => {
  it.each([
    ["card", 3],
    ["list", 3],
    ["chips", 2],
  ] as const)("%s の形：最初の描画から role=status と「読み込み中」があり、行の数は固定（%i）", (variant, rows) => {
    const view = render(<Loading variant={variant} />);
    const status = screen.getByRole("status", { name: "読み込み中" });
    expect(status).toHaveAttribute("data-variant", variant);
    expect(status).toHaveClass("kh-skeleton");
    // 骨組みの普段のクラスに opacity-0 を置かない（動きを止める設定で animation: none になっても見える）
    expect(view.container.innerHTML).not.toMatch(/opacity-0/);
    const count = variant === "card" ? status.children.length : status.querySelectorAll(".rounded-full.size-10").length;
    expect(count).toBe(rows);
  });

  it("形を渡さなければ今のカードの形", () => {
    render(<Loading />);
    expect(screen.getByRole("status", { name: "読み込み中" })).toHaveAttribute("data-variant", "card");
  });

  it("index.css：200ms の遅れのあとに kh-fade-in（from だけ・backwards）で出て、出終わってから kh-breathe で明滅する", () => {
    const skeleton = rule(".kh-skeleton");
    expect(skeleton).toMatch(/kh-fade-in var\(--duration-fast\) var\(--ease-out\) 200ms backwards/);
    expect(skeleton).toMatch(/kh-breathe 1\.4s ease-in-out calc\(200ms \+ var\(--duration-fast\)\) infinite/);
    const fadeIn = /@keyframes kh-fade-in\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(fadeIn).toMatch(/from\s*\{\s*opacity: 0;\s*\}/);
    expect(fadeIn).not.toMatch(/\bto\b/);
    const breathe = /@keyframes kh-breathe\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(breathe).toMatch(/opacity: 0\.55/);
  });
});

describe("FadeIn（M-06）・EmptyState（M-19）", () => {
  it("FadeIn は描いたときにフェードで入り、普段のクラスに opacity-0 がない", () => {
    render(
      <FadeIn className="flex flex-col">
        <p>中身</p>
      </FadeIn>,
    );
    const box = screen.getByText("中身").parentElement as HTMLElement;
    expect(box).toHaveClass("kh-fade", "flex", "flex-col");
    expect(box.className).not.toMatch(/opacity-0/);
    expect(rule(".kh-fade")).toMatch(/kh-fade-in var\(--duration-fast\) var\(--ease-out\) backwards/);
  });

  it("読み込み中（Loading）を出す画面は、読み込みのあと最初に描く中身をフェードで入れる（FadeIn か kh-fade）", () => {
    const files = [
      "../pages/EveryonePage.tsx",
      "../pages/NotificationsPage.tsx",
      "../pages/FriendDetailPage.tsx",
      "../pages/InviteDetailPage.tsx",
      "../pages/BroadcastDetailPage.tsx",
      "../pages/MeetupDetailPage.tsx",
      "../pages/FriendsPage.tsx",
      "../pages/BlockedUsersPage.tsx",
      "../pages/InvitesPage.tsx",
      "../wish/MyWishes.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(source, file).toMatch(/<FadeIn|"kh-fade /);
    }
    // 募集は、送った・受け取った一覧のそれぞれ（読み込みより先に描く外の箱ではない）
    expect(readFileSync(join(import.meta.dirname, "../pages/InvitesPage.tsx"), "utf8")).toMatch(/<ul aria-label=\{label\} className="kh-fade /);
  });

  it("EmptyState は下から8pxのフェードで入る（base・ease-out）。普段のクラスに opacity-0 がない", () => {
    render(<EmptyState title="まだありません" />);
    const box = screen.getByText("まだありません").parentElement as HTMLElement;
    expect(box).toHaveClass("animate-kh-rise");
    expect(box.className).not.toMatch(/opacity-0/);
    expect(css).toMatch(/--animate-kh-rise: kh-rise var\(--duration-base\) var\(--ease-out\) backwards;/);
    expect(/@keyframes kh-rise\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]).toMatch(/translateY\(8px\)/);
  });
});

describe("オフラインの帯（V-2）", () => {
  it("つながっているあいだは何も描かない（空の入れ物で中身の隙間を作らない）", () => {
    network();
    const view = render(<OfflineBanner />);
    expect(view.container.innerHTML).toBe("");
  });

  it("オフラインになると、帯が Collapse の開く側で出る。つながると閉じて、閉じ終わったら入れ物ごと消える", () => {
    vi.useFakeTimers();
    // 動きを止めない設定
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    const setOnline = network();
    const view = render(<OfflineBanner />);
    setOnline(false);
    // 描いた直後は閉じた形で、次のフレームのあとに開く
    const box = () => view.container.querySelector(".kh-collapse") as HTMLElement;
    expect(box()).toHaveAttribute("data-closed");
    act(() => vi.advanceTimersByTime(50));
    expect(box()).not.toHaveAttribute("data-closed");
    expect(screen.getByRole("status")).toHaveTextContent("オフラインです");
    setOnline(true);
    expect(box()).toHaveAttribute("data-closed");
    act(() => vi.advanceTimersByTime(210));
    expect(view.container.innerHTML).toBe("");
  });

  it("親の gap の分は帯の中の下の余白に持ち、入れ物の負の余白で打ち消す（出し入れで下の中身が gap の分だけ跳ねない）", () => {
    const setOnline = network();
    const view = render(<OfflineBanner />);
    setOnline(false);
    const box = view.container.querySelector(".kh-collapse") as HTMLElement;
    expect(box).toHaveClass("-mb-4");
    expect(box.firstElementChild?.firstElementChild).toHaveClass("pb-4");
    view.unmount();
    const sheet = render(<OfflineBanner gap="s" />);
    const sheetBox = sheet.container.querySelector(".kh-collapse") as HTMLElement;
    expect(sheetBox).toHaveClass("-mb-2");
    expect(sheetBox.firstElementChild?.firstElementChild).toHaveClass("pb-2");
  });

  it("動きを止める設定（jsdom の既定）では、オフラインになるとすぐ開いた形で出る", () => {
    const setOnline = network();
    const view = render(<OfflineBanner />);
    setOnline(false);
    expect(view.container.querySelector(".kh-collapse")).not.toHaveAttribute("data-closed");
    expect(screen.getByRole("status")).toHaveTextContent("オフラインです");
  });
});
