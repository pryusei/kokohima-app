import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inputClass } from "./form";

// 入力欄がシートの幅をはみ出さない（docs/specs/T-11-design.md「画面のつながり」、テスト計画）

// CSS の ?raw は vitest では空になるので、ファイルを直接読む
const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

describe("入力欄の幅", () => {
  it("入力欄は親の幅より広がらない（min-w-0 と max-w-full）", () => {
    const classes = inputClass.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["w-full", "min-w-0", "max-w-full"]));
  });

  it("日付・時刻の入力欄は、iPhone の Safari の標準の見た目を外して、中身の幅で広がらないようにする", () => {
    const rule = /input\[type="date"\],\s*input\[type="time"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/-webkit-appearance:\s*none/);
    expect(rule).toMatch(/display:\s*block/);
  });
});
