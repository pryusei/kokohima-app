import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// フォーカスの輪（docs/specs/T-46-countered-card-focus-ring.md、docs/specs/T-11-design.md「デザインの決まり」）

// CSS の ?raw は vitest では空になるので、ファイルを直接読む
const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** 輪を消す指定：outline-none・outline-hidden・outline-0、フォーカスの影（影のクラスと取り合うので使わない） */
const HIDES_RING = /(?:^|[\s"'`])(?:[\w-]+:)*outline-(?:none|hidden|0)\b|focus(?:-visible)?:shadow-/g;

describe("フォーカスの輪", () => {
  const rule = /:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("outline で描く（影のクラスに上書きされず、強制カラーのモードでも出る）", () => {
    expect(rule).toMatch(/outline:\s*2px solid var\(--color-focus\)/);
    expect(rule).toMatch(/outline-offset:\s*2px/);
    expect(rule).not.toMatch(/outline:\s*none/);
    expect(rule).not.toMatch(/box-shadow/);
  });

  it("ソースで輪を消さない", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const found = Object.entries(sources).flatMap(([path, text]) =>
      (text.match(HIDES_RING) ?? []).map((m) => `${path}: ${m.trim()}`),
    );
    expect(found).toEqual([]);
  });

  it("検査が輪を消す指定を見つけられる", () => {
    expect(' className="focus:outline-none outline-hidden peer-focus-visible:shadow-card"'.match(HIDES_RING)).toHaveLength(3);
    expect(' className="peer-focus-visible:outline-2 peer-focus-visible:outline-focus shadow-card"'.match(HIDES_RING)).toBeNull();
  });
});
