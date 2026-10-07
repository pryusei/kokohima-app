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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter api dev:e2e --port 8787",
      url: "http://localhost:8787/api/v1/health",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "E2E=1 pnpm --filter web dev",
      url: "http://localhost:5173",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});
