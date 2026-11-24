import { describe, expect, it } from "vitest";
import { dragVelocity, sheetDragOffset, sheetDragOutcome } from "./sheetDrag";

// シートの引っぱりの判定（docs/specs/T-56-motion.md「M-02」、テスト計画「実装PR①」）

const base = { origin: "grip" as const, moved: 0, maxMoved: 0, velocity: 0, height: 600 };

describe("sheetDragOutcome", () => {
  it("つまみから始めて、maxMoved 9px はタップ、10px はタップでない", () => {
    expect(sheetDragOutcome({ ...base, moved: 9, maxMoved: 9 })).toBe("tap");
    expect(sheetDragOutcome({ ...base, moved: 10, maxMoved: 10 })).not.toBe("tap");
  });

  it("見出しの行から始めて maxMoved 9px は settle（タップにならない）", () => {
    expect(sheetDragOutcome({ ...base, origin: "header", moved: 9, maxMoved: 9 })).toBe("settle");
    expect(sheetDragOutcome({ ...base, origin: "header" })).toBe("settle");
  });

  it("高さ600pxで、moved 179px・速さ0.4は settle、180px は close", () => {
    expect(sheetDragOutcome({ ...base, moved: 179, maxMoved: 179, velocity: 0.4 })).toBe("settle");
    expect(sheetDragOutcome({ ...base, moved: 180, maxMoved: 180, velocity: 0.4 })).toBe("close");
    expect(sheetDragOutcome({ ...base, origin: "header", moved: 180, maxMoved: 180 })).toBe("close");
  });

  it("moved 30px で、速さ0.5は close、0.49は settle", () => {
    expect(sheetDragOutcome({ ...base, moved: 30, maxMoved: 30, velocity: 0.5 })).toBe("close");
    expect(sheetDragOutcome({ ...base, moved: 30, maxMoved: 30, velocity: 0.49 })).toBe("settle");
  });

  it("上へ引いて（moved が負）、速さが大きくても close にしない。下へ引いてから戻して離しても close にしない", () => {
    expect(sheetDragOutcome({ ...base, moved: -200, maxMoved: 200, velocity: 3 })).toBe("settle");
    expect(sheetDragOutcome({ ...base, moved: 0, maxMoved: 300, velocity: 3 })).toBe("settle");
  });
});

describe("sheetDragOffset", () => {
  it("下はそのまま、上は1/3", () => {
    expect(sheetDragOffset(120)).toBe(120);
    expect(sheetDragOffset(0)).toBe(0);
    expect(sheetDragOffset(-90)).toBe(-30);
  });
});

describe("dragVelocity", () => {
  it("離す直前の100msの中で一番古い位置から測る。100msより前の位置は使わない", () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 950, y: 100 },
      { t: 980, y: 120 },
    ];
    expect(dragVelocity(samples, 1000, 150)).toBeCloseTo(1); // (150 - 100) / 50
  });

  it("100msの中に位置がない・時間が経っていないときは0", () => {
    expect(dragVelocity([{ t: 0, y: 0 }], 1000, 300)).toBe(0);
    expect(dragVelocity([{ t: 1000, y: 0 }], 1000, 300)).toBe(0);
  });
});
