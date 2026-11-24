import { describe, expect, it } from "vitest";
import { directionOf, isSheetPath, transitionKind } from "../router";
import { rememberTabScroll, scrollTargetOnPop, tabScrollTarget } from "./tabScroll";

// スクロールの位置と画面の切り替えの種類（docs/specs/T-56-motion.md「M-07」「M-13」、テスト計画「実装PR③」）

describe("タブのスクロールの位置", () => {
  it("覚える・初めては0・タブごとに別", () => {
    const empty = new Map<string, number>();
    expect(tabScrollTarget(empty, "/friends")).toBe(0);
    const a = rememberTabScroll(empty, "/friends", 420);
    const b = rememberTabScroll(a, "/", 80);
    expect(tabScrollTarget(b, "/friends")).toBe(420);
    expect(tabScrollTarget(b, "/")).toBe(80);
    expect(tabScrollTarget(b, "/invites")).toBe(0);
    // 純粋な関数：元の表は変えない
    expect(empty.size).toBe(0);
    expect(tabScrollTarget(a, "/")).toBe(0);
    expect(tabScrollTarget(rememberTabScroll(b, "/friends", 10), "/friends")).toBe(10);
  });

  it("scrollTargetOnPop：エントリの位置があればそれ、なければタブの位置、どちらもなければ0", () => {
    const entries = new Map([["k1", 300]]);
    const tabs = new Map([["/friends", 120]]);
    expect(scrollTargetOnPop(entries, tabs, { key: "k1", tab: "/friends" })).toBe(300);
    expect(scrollTargetOnPop(entries, tabs, { key: "k2", tab: "/friends" })).toBe(120);
    expect(scrollTargetOnPop(entries, tabs, { key: null, tab: "/friends" })).toBe(120);
    expect(scrollTargetOnPop(entries, tabs, { key: "k1", tab: null })).toBe(300);
    expect(scrollTargetOnPop(entries, tabs, { key: "k2", tab: null })).toBe(0);
    expect(scrollTargetOnPop(entries, tabs, { key: null, tab: "/invites" })).toBe(0);
  });
});

describe("transitionKind", () => {
  it("シートが関わると none（シートは M-01 の動き。popstate で閉じたときも即時）", () => {
    expect(transitionKind("/invites", "/invites/abc", "forward")).toBe("none");
    expect(transitionKind("/invites/abc", "/invites", "back")).toBe("none");
    expect(transitionKind("/", "/invites/new", "forward")).toBe("none");
    expect(transitionKind("/friends/x", "/settings", "forward")).toBe("none");
  });

  it("タブどうしは fade、設定へは push、戻るは pop", () => {
    expect(transitionKind("/", "/friends", "forward")).toBe("fade");
    expect(transitionKind("/friends", "/", "back")).toBe("fade");
    expect(transitionKind("/friends", "/settings", "forward")).toBe("push");
    expect(transitionKind("/settings", "/settings/calendar", "forward")).toBe("push");
    expect(transitionKind("/settings/calendar", "/settings", "back")).toBe("pop");
    expect(transitionKind("/settings", "/friends", "back")).toBe("pop");
    expect(transitionKind("/", "/notifications", "forward")).toBe("push");
  });

  it("同じ画面の中（?tab= だけが変わる）は none", () => {
    expect(transitionKind("/invites", "/invites", "forward")).toBe("none");
  });

  it("hasUAVisualTransition が true の popstate は none（ブラウザの戻る動きと二重にしない）", () => {
    expect(transitionKind("/settings/calendar", "/settings", "back", true)).toBe("none");
    expect(transitionKind("/", "/friends", "back", true)).toBe("none");
    expect(transitionKind("/settings/calendar", "/settings", "back", false)).toBe("pop");
  });

  it("depth の比べ方：移った先が浅ければ戻る、深い・同じなら進む", () => {
    expect(directionOf(2, 1)).toBe("back");
    expect(directionOf(1, 2)).toBe("forward");
    expect(directionOf(0, 0)).toBe("forward");
  });

  it("isSheetPath は App.tsx の sheetOf の表と同じ URL", () => {
    for (const path of ["/invites/new", "/broadcasts/new", "/invites/x", "/broadcasts/x", "/meetups/x", "/friends/x"]) expect(isSheetPath(path)).toBe(true);
    for (const path of ["/", "/invites", "/friends", "/settings", "/settings/calendar", "/notifications", "/friends/x/y"]) expect(isSheetPath(path)).toBe(false);
  });
});
