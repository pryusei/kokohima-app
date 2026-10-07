import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

// 単体テストは Workers のランタイム（Miniflare）上で動かす。D1にはマイグレーションを適用してから使う
export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          APP_ORIGIN: "https://app.test",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          APPLE_CLIENT_ID: "jp.kokohima.test",
          APPLE_TEAM_ID: "TEAMID1234",
          APPLE_KEY_ID: "KEYID12345",
          // APPLE_PRIVATE_KEY はテストの中で生成して差し替える
          APPLE_PRIVATE_KEY: "",
          JWT_SIGNING_KEYS: JSON.stringify({
            "test-1": "dGVzdC1rZXktMS10ZXN0LWtleS0xLXRlc3Qta2V5LTEtdGVzdA",
            "test-old": "b2xkLWtleS1vbGQta2V5LW9sZC1rZXktb2xkLWtleS1vbGQ",
          }),
          JWT_CURRENT_KID: "test-1",
        },
      },
    })),
  ],
  test: { name: "api", setupFiles: ["./test/apply-migrations.ts"] },
});
