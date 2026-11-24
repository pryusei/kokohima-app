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

/**
 * 輪を消す指定：outline-none・outline-hidden・outline-0・outline-transparent（任意の変種 `[&:focus]:` も含む）、
 * フォーカスの影（影のクラスと取り合うので使わない）、インラインの style の outline: none / 0
 */
const HIDES_RING =
  /(?:^|[\s"'`])(?:(?:[\w-]+|\[[^\]\s]+\]):)*outline-(?:none|hidden|0|transparent)\b|focus(?:-visible)?:shadow-|\boutline:\s*["'`]?(?:none|0)\b/g;

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
    expect(' className="[&:focus]:outline-none focus-visible:outline-transparent"'.match(HIDES_RING)).toHaveLength(2);
    expect('<div style={{ outline: "none" }} />'.match(HIDES_RING)).toHaveLength(1);
    expect(' className="peer-focus-visible:outline-2 peer-focus-visible:outline-focus shadow-card"'.match(HIDES_RING)).toBeNull();
  });
});

describe("押したときの感触（docs/specs/T-56-motion.md「M-11」）", () => {
  /** active: で見た目を変えるクラスの文字列 */
  const pressStrings = (text: string) => [...text.matchAll(/(["'`])((?:(?!\1).)*\b(?:group-)?active:(?:(?!\1).)*)\1/g)].map((m) => m[2] ?? "");

  it.each([
    ["./InviteCard.tsx", "active:scale-[.98]"],
    ["../pages/SettingsPage.tsx", "active:bg-surface-sunken"],
    ["../pages/FriendsPage.tsx", "active:bg-surface-sunken"],
    ["./NotificationRow.tsx", "active:bg-surface-sunken"],
    ["../pages/BlockedUsersPage.tsx", "active:bg-surface-sunken"],
    ["../pages/EveryonePage.tsx", "active:scale-[.95]"],
  ])("%s に押した感触（%s）があり、press の長さで動く", (path, press) => {
    const text = sources[path] ?? "";
    expect(text).toContain(press);
    expect(text).toMatch(/duration-\(--duration-press\)/);
  });

  it("行は PC でマウスを乗せたときも沈み、カードはマウスを乗せると影を shadow-float に（静かなカードは影を足さない）", () => {
    for (const path of ["../pages/SettingsPage.tsx", "./NotificationRow.tsx", "../pages/BlockedUsersPage.tsx", "../pages/FriendsPage.tsx"]) {
      expect(sources[path], path).toContain("lg:hover:bg-surface-sunken");
    }
    const card = sources["./InviteCard.tsx"] ?? "";
    expect(card).toContain("active:shadow-none lg:hover:shadow-float");
    expect(card).toMatch(/tone === "quiet"\s*\?\s*"border border-line bg-surface"/);
  });

  it("押した感触のクラスは outline を書き換えず、transition に outline を含めない（transition-colors・transition-all を使わない）", () => {
    const found = Object.entries(sources).flatMap(([path, text]) =>
      pressStrings(text)
        .filter((cls) =>
          cls
            .split(/\s+/)
            .some((token) => (/active:/.test(token) && /outline/.test(token)) || /^(?:[\w-]+:)*transition(?:-colors|-all)?$/.test(token)),
        )
        .map((cls) => `${path}: ${cls}`),
    );
    expect(found).toEqual([]);
  });

  it("index.css で、タップしたときの既定の色（-webkit-tap-highlight-color）を消す", () => {
    expect(css).toMatch(/-webkit-tap-highlight-color: transparent;/);
  });
});
