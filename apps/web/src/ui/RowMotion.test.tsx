import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody, waitForShellGone } from "../test/helpers";
import { markCreatedRow, MotionRow, useRowExits } from "./RowMotion";

// 自分の操作で増える・消える行（docs/specs/T-56-motion.md「M-10」、テスト計画「実装PR③」）

const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

type Item = { id: string; text: string };
const keyOf = (i: Item) => i.id;

/** 行を出し、行ごとに「消す」「戻す」を置いた一覧 */
function List({ items, inSheet = false }: { items: Item[]; inSheet?: boolean }) {
  const exits = useRowExits(items, keyOf);
  return (
    <>
      {/* 閉じ終わって描いていない行を、失敗として戻す */}
      <button type="button" onClick={() => exits.restore("a")}>
        あを外から戻す
      </button>
      <ul aria-label="一覧">
      {exits.rows.map((row) => (
        <MotionRow key={row.key} row={row} onHidden={exits.hidden} onAppeared={exits.appeared} inSheet={inSheet} className="py-3">
          <span>{row.item.text}</span>
          <button type="button" onClick={() => exits.leave(row.key)}>
            {`${row.item.text}を消す`}
          </button>
          <button type="button" onClick={() => exits.restore(row.key)}>
            {`${row.item.text}を戻す`}
          </button>
        </MotionRow>
      ))}
      </ul>
    </>
  );
}

const A = { id: "a", text: "あ" };
const B = { id: "b", text: "い" };
const C = { id: "c", text: "う" };

const rowOf = (text: string) => screen.getByText(text).closest("li") as HTMLElement;
/** n 番めの行（開く前の行は中身を描いていないので、位置で探す） */
const nth = (n: number) => screen.getAllByRole("listitem")[n] as HTMLElement;
const texts = () => [...document.querySelectorAll("li")].map((li) => li.querySelector("span")?.textContent ?? "");

function motion() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll(".kh-sheet-scrim").forEach((el) => el.remove());
});

describe("useRowExits と MotionRow（止めない設定）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    motion();
  });

  it("消す：行が Collapse の閉じる側になり、保険のタイマー（160＋50ms）のあとに描かない（一覧から消える前でも）", () => {
    render(<List items={[A, B, C]} />);
    act(() => screen.getByRole("button", { name: "いを消す" }).click());
    expect(rowOf("い")).toHaveAttribute("data-closed");
    expect(rowOf("い")).toHaveClass("kh-collapse");
    act(() => vi.advanceTimersByTime(209));
    expect(texts()).toEqual(["あ", "い", "う"]);
    act(() => vi.advanceTimersByTime(1));
    expect(texts()).toEqual(["あ", "う"]);
  });

  it("楽観的更新で一覧から先に消えても、閉じ終わるまで元の場所に描く。失敗して一覧に戻ると、元の場所に開いて戻る", () => {
    const view = render(<List items={[A, B, C]} />);
    act(() => screen.getByRole("button", { name: "いを消す" }).click());
    view.rerender(<List items={[A, C]} />);
    expect(texts()).toEqual(["あ", "い", "う"]);
    act(() => vi.advanceTimersByTime(210));
    expect(texts()).toEqual(["あ", "う"]);
    // 送れなかった：元の場所に戻る。閉じた形で描き始めて、次のフレームのあとに開く
    view.rerender(<List items={[A, B, C]} />);
    expect(nth(1)).toHaveAttribute("data-closed");
    act(() => vi.advanceTimersByTime(50));
    expect(rowOf("い")).not.toHaveAttribute("data-closed");
    expect(texts()).toEqual(["あ", "い", "う"]);
  });

  it("閉じる途中で失敗して戻すと、中身を消さずに開いた形へ戻る", () => {
    render(<List items={[A, B]} />);
    act(() => screen.getByRole("button", { name: "あを消す" }).click());
    act(() => vi.advanceTimersByTime(100));
    act(() => screen.getByRole("button", { name: "あを戻す" }).click());
    expect(rowOf("あ")).not.toHaveAttribute("data-closed");
    act(() => vi.advanceTimersByTime(1000));
    expect(texts()).toEqual(["あ", "い"]);
  });

  it("閉じ終わったあとに失敗して戻す（restore）と、元の場所に開いて戻る", () => {
    render(<List items={[A, B]} />);
    act(() => screen.getByRole("button", { name: "あを消す" }).click());
    act(() => vi.advanceTimersByTime(210));
    expect(texts()).toEqual(["い"]);
    // 一覧には残っている（読み直しの前）に失敗した
    act(() => screen.getByRole("button", { name: "あを外から戻す" }).click());
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(nth(0)).toHaveAttribute("data-closed");
    act(() => vi.advanceTimersByTime(50));
    expect(rowOf("あ")).not.toHaveAttribute("data-closed");
    expect(texts()).toEqual(["あ", "い"]);
  });

  it("自分が増やした行は、閉じた形から開き、開いたあとに一度だけ光る（作り直しても、もう光らない）", () => {
    const view = render(<List items={[A]} />);
    markCreatedRow("b");
    view.rerender(<List items={[A, B]} />);
    expect(nth(1)).toHaveAttribute("data-closed");
    expect(screen.queryByText("い")).toBeNull();
    act(() => vi.advanceTimersByTime(50));
    expect(rowOf("い")).not.toHaveAttribute("data-closed");
    expect(screen.getByText("い").parentElement).toHaveClass("kh-row-glow");
    // 友達から増えた（自分が作っていない）行は光らない
    expect(screen.getByText("あ").parentElement).not.toHaveClass("kh-row-glow");
    view.unmount();
    render(<List items={[A, B]} />);
    expect(rowOf("い")).not.toHaveAttribute("data-closed");
    expect(screen.getByText("い").parentElement).not.toHaveClass("kh-row-glow");
  });

  it("後ろの一覧の増えた行は、シートが閉じ終わってから開く。シートの中の一覧はすぐ開く", async () => {
    const scrim = document.createElement("div");
    scrim.className = "kh-sheet-scrim";
    document.body.append(scrim);
    markCreatedRow("c");
    const view = render(<List items={[A, C]} />);
    act(() => vi.advanceTimersByTime(100));
    expect(nth(1)).toHaveAttribute("data-closed");
    // MutationObserver の知らせは、あとのマイクロタスクで届く
    await act(async () => {
      scrim.remove();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(50));
    expect(rowOf("う")).not.toHaveAttribute("data-closed");
    view.unmount();
    document.body.append(scrim);
    markCreatedRow("b");
    render(<List items={[A, B]} inSheet />);
    act(() => vi.advanceTimersByTime(50));
    expect(rowOf("い")).not.toHaveAttribute("data-closed");
  });

  it("光る動きは、開いたあと（base の遅れ）に surface-sunken から元の色へ戻る 600ms（sheet＋base）", () => {
    expect(css).toMatch(
      /\.kh-row-glow\s*\{\s*animation: kh-row-glow calc\(var\(--duration-sheet\) \+ var\(--duration-base\)\) var\(--ease-out\) var\(--duration-base\) backwards;/,
    );
    expect(/@keyframes kh-row-glow\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]).toMatch(/from\s*\{\s*background-color: var\(--color-surface-sunken\);/);
    expect(css).not.toMatch(/kh-row-glow[^}]*lamp/);
  });
});

describe("動きを止める設定（jsdom の既定）", () => {
  it("消すとすぐ描かず、増えた行もすぐ開いた形", () => {
    const view = render(<List items={[A, B]} />);
    act(() => screen.getByRole("button", { name: "あを消す" }).click());
    expect(texts()).toEqual(["い"]);
    markCreatedRow("c");
    view.rerender(<List items={[B, C]} />);
    expect(rowOf("う")).not.toHaveAttribute("data-closed");
  });
});

describe("画面の一覧（M-10）", () => {
  const LINK_ID = "44444444-4444-4444-8444-444444444444";
  const link = { id: LINK_ID, expiresAt: "2026-12-01T00:00:00.000Z", maxUses: 5, uses: 1, createdAt: "2026-11-24T00:00:00.000Z" };
  const empty = json({ items: [], nextCursor: null });
  const friendsTab = {
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/notifications/unread-count": json({ count: 0 }),
    "/api/v1/me": json({ id: "11111111-1111-4111-8111-111111111111", displayName: "ゆう", avatarUrl: null }),
    "/api/v1/friends": empty,
  };
  beforeEach(() => {
    tokenStore.clear();
    window.history.replaceState(null, "", "/friends");
    motion();
  });

  it("招待リンクの「無効にする」：行が閉じる側になり、閉じ終わると消える", async () => {
    mockFetch({
      ...friendsTab,
      "/api/v1/invite-links": [json({ items: [link], nextCursor: null }), empty],
      [`/api/v1/invite-links/${LINK_ID}/revoke`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    await waitForShellGone();
    const button = await screen.findByRole("button", { name: "無効にする" });
    const row = button.closest("li") as HTMLElement;
    await userEvent.click(button);
    expect(row).toHaveAttribute("data-closed");
    await waitFor(() => expect(screen.queryByRole("button", { name: "無効にする" })).toBeNull());
  });

  it("招待リンクの「無効にする」が失敗したら、行は元の場所に開いて戻る", async () => {
    mockFetch({
      ...friendsTab,
      "/api/v1/invite-links": json({ items: [link], nextCursor: null }),
      [`/api/v1/invite-links/${LINK_ID}/revoke`]: () => new Response(null, { status: 503 }),
    });
    renderApp();
    await waitForShellGone();
    await userEvent.click(await screen.findByRole("button", { name: "無効にする" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "無効にする" }).closest("li")).not.toHaveAttribute("data-closed"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByRole("button", { name: "無効にする" })).toBeInTheDocument();
  });
});
