import { defineConfig } from "vitest/config";

// ルートの `pnpm test [path]` で全パッケージのテストを実行する
export default defineConfig({
  test: {
    projects: [
      "apps/*",
      "packages/*",
      // E2E の設定（Playwright のプロジェクト・テストの印）を確かめる単体テスト。Playwright が拾わないように *.unit.ts にする（docs/specs/T-21-webkit-e2e.md）
      { test: { name: "e2e-config", include: ["e2e/**/*.unit.ts"], environment: "node" } },
    ],
  },
});
