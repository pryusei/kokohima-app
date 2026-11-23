import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;

// E2E は API（wrangler dev --env e2e）と Web（vite）をローカルで起動して実行する
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /release\.spec\.ts/ },
    // 本番と同じ形（ビルドした画面を同じ Worker の静的アセットとして出す）で、CSP の違反がないかを確かめる（docs/specs/T-12-release.md）
    {
      name: "release",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:8788" },
      testMatch: /release\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: "pnpm --filter api dev:e2e --port 8787",
      url: "http://localhost:8787/api/v1/health",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      // 画面をビルドし、本番と同じエントリ（src/index.ts）と静的アセットで wrangler dev を起動する（テスト用ログインの経路はない）
      command: "pnpm --filter api dev:assets",
      url: "http://localhost:8788/api/v1/health",
      reuseExistingServer: !isCI,
      timeout: 180_000,
    },
    {
      command: "E2E=1 pnpm --filter web dev",
      url: "http://localhost:5173",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});
