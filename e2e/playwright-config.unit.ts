import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../playwright.config";

// iPhone の Safari（WebKit）で E2E を回す設定（docs/specs/T-21-webkit-e2e.md「テスト計画」）

const project = (name: string) => config.projects?.find((p) => p.name === name);
const matches = (pattern: unknown, file: string) =>
  (Array.isArray(pattern) ? pattern : [pattern]).some((p) => p instanceof RegExp && p.test(file));

describe("Playwright の iphone のプロジェクト", () => {
  it("WebKit（iPhone 13 の端末の設定）で、@iphone の印を付けたテストだけを HTTPS の画面で回す", () => {
    const iphone = project("iphone");
    expect(iphone?.use?.defaultBrowserType).toBe("webkit");
    expect(iphone?.use?.isMobile).toBe(true);
    expect(iphone?.use?.viewport).toEqual({ width: 390, height: 664 });
    expect(iphone?.grep).toEqual(/@iphone/);
    // WebKit は http://localhost では __Host- の Secure の Cookie を保存しないので、HTTPS の画面で開く
    expect(iphone?.use?.baseURL).toBe("https://localhost:5174");
  });

  it("本番と同じ形の確認（release）と PC の配置（desktop）は回さない", () => {
    const iphone = project("iphone");
    expect(matches(iphone?.testIgnore, "e2e/release.spec.ts")).toBe(true);
    expect(matches(iphone?.testIgnore, "e2e/desktop.spec.ts")).toBe(true);
  });

  it("ほかのプロジェクトは Chromium のままで、印で絞らない", () => {
    for (const name of ["mobile", "desktop", "release"]) {
      expect(project(name)?.use?.defaultBrowserType, name).toBe("chromium");
      expect(project(name)?.grep, name).toBeUndefined();
    }
  });

  it("HTTPS の画面と、その Origin に合わせた API を起動する", () => {
    const servers = Array.isArray(config.webServer) ? config.webServer : [config.webServer];
    expect(servers.map((s) => s?.url)).toEqual(expect.arrayContaining(["https://localhost:5174", "http://localhost:8789/api/v1/health"]));
  });
});

/** WebKit でも回すテスト（仕様書の表）。ファイルごとのテストの名前 */
const IPHONE_TESTS: Record<string, string[]> = {
  "auth.spec.ts": [
    "ログイン済みでアプリを開くとホーム（みんな）になり、再読み込みしても続く",
    "ログイン中、localStorage・sessionStorage にアクセストークンがない",
  ],
  "navigation.spec.ts": [
    "下のタブで みんな → ここ暇 → 誘い → 友達 と移れ、ヘッダーの鐘からお知らせが開ける",
    "スマホの幅で、みんなタブから開いた募集の作成のシートを「閉じる」のボタンで閉じると、みんなタブに戻り、開いたボタンにフォーカスが戻る",
    "誘いの一覧のカードから詳細がシートで開き、「行く」のあとシートを閉じると誘いタブに戻る",
    "お知らせのリンクのように誘いの URL を直接開いて閉じると、アプリの外に出ず誘いタブへ移る",
  ],
  "invites.spec.ts": ["AがBの見えている枠から誘う（あそぼ）→ Bが「行く」→ 双方の「成立」に予定が出る"],
  "broadcasts.spec.ts": ["AがB・C・Dに募集 → BとCが応じる → Aには人数だけ → 決める → A・B・Cに予定、Dは募集中のまま"],
  "contact.spec.ts": ["友達タブ → 設定 → 問い合わせで、不具合を送ると「送りました」が出て、偽の Slack にエスケープされて1通届く"],
};

describe("@iphone の印", () => {
  it.each(Object.entries(IPHONE_TESTS))("%s の決めたテストに @iphone が付いている", (file, names) => {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    for (const name of names) {
      expect(source, name).toContain(`test("${name}", { tag: "@iphone" },`);
    }
  });
});
