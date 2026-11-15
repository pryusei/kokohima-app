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
          CALENDAR_TOKEN_KEYS: JSON.stringify({
            "cal-1": "Y2FsLWtleS0xLWNhbC1rZXktMS1jYWwta2V5LTEtY2E",
            "cal-old": "b2xkLWNhbC1rZXktb2xkLWNhbC1rZXktb2xkLWNhbCE",
          }),
          CALENDAR_TOKEN_CURRENT_KID: "cal-1",
          // 通知（T-07）。VAPID の鍵はテスト専用（本番では使わない）
          RESEND_API_KEY: "re_test_key",
          VAPID_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg7jBHfSgXWj51x/Kr\nB1yX515Ey/R4brF3uWcywJZq15yhRANCAATjQz7mClg0F2er68NIGogPm99EOsBA\n1laX+ifoRhM6NtN9lrm1lB6rCsPII63F9FtJu+W6lhEW8zONmjZ2xSlj\n-----END PRIVATE KEY-----\n",
          VAPID_PUBLIC_KEY: "BONDPuYKWDQXZ6vrw0gaiA-b30Q6wEDWVpf6J-hGEzo2032WubWUHqsKw8gjrcX0W0m75bqWERbzM42aNnbFKWM",
          VAPID_SUBJECT: "mailto:ops@kokohima.test",
          NOTIFICATION_KEYS: JSON.stringify({ "push-1": "cHVzaC1rZXktMS1wdXNoLWtleS0xLXB1c2gta2V5LTE" }),
          NOTIFICATION_CURRENT_KID: "push-1",
          MAIL_FROM: "ここ暇 <notify@kokohima.test>",
          NOTIFICATION_START_AT: "0",
          MAIL_DAILY_LIMIT: "90",
        },
      },
    })),
  ],
  test: { name: "api", setupFiles: ["./test/apply-migrations.ts"] },
});
