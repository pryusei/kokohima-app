import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// CSS の ?raw は vitest では空になるので、ファイルを直接読む
const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

// 色の直書きがないこと・赤を使わないこと（docs/specs/T-11-design.md「トークンとテーマ」、テスト計画）

const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Tailwind の既定の色の名前（index.css の --color-*: initial で消している） */
const DEFAULT_COLORS = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose", "white", "black",
];
const UTILITY = "(?:bg|text|border(?:-[trblxy])?|ring|outline|fill|stroke|from|via|to|divide|accent|decoration|caret|placeholder|shadow)";
const DEFAULT_COLOR_CLASS = new RegExp(`\\b${UTILITY}-(?:${DEFAULT_COLORS.join("|")})(?:-\\d{2,3})?\\b`, "g");

function hsl(hex: string) {
  const v = hex.replace("#", "").slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

describe("色", () => {
  it("ソースに Tailwind の既定の色の名前を使った指定がない", () => {
    const found = Object.entries(sources).flatMap(([path, text]) => (text.match(DEFAULT_COLOR_CLASS) ?? []).map((m) => `${path}: ${m}`));
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(found).toEqual([]);
  });

  it("紹介のページ（landing.html。docs/specs/T-44-landing.md「3.」）も、既定の色を使わずトークンで書く", () => {
    const landing = readFileSync(join(import.meta.dirname, "../../landing.html"), "utf8");
    expect(landing.match(DEFAULT_COLOR_CLASS) ?? []).toEqual([]);
    expect(landing).toMatch(/\bbg-bg\b/);
    expect(landing).toMatch(/\bbg-action\b/);
  });

  it("トークンに赤の色相の値がない", () => {
    const hexes = css.match(/#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g) ?? [];
    expect(hexes.length).toBeGreaterThan(20);
    const reds = hexes.filter((hex) => {
      const { h, s, l } = hsl(hex);
      return (h <= 20 || h >= 340) && s > 0.4 && l > 0.15 && l < 0.85;
    });
    expect(reds).toEqual([]);
  });

  it("検査が既定の色の指定を見つけられる", () => {
    expect("text-slate-600 bg-red-50 border-emerald-200".match(DEFAULT_COLOR_CLASS)).toHaveLength(3);
    expect("bg-surface text-ink-muted bg-quiet-bg".match(DEFAULT_COLOR_CLASS)).toBeNull();
  });
});
