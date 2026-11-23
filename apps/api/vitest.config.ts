import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

// 単体テストは Workers のランタイム（Miniflare）上で動かす。D1にはマイグレーションを適用してから使う
export default defineProject({
  // メールの色が web のトークンと一致することを確かめる（notification/domain/mail.test.ts）。Workers には fs がないので、ここで読む
  define: {
    __WEB_INDEX_CSS__: JSON.stringify(readFileSync(path.join(import.meta.dirname, "../web/src/index.css"), "utf8")),
    // WAF のルールの遮断するパスの一覧を確かめる（http/waf-rule.test.ts、docs/specs/T-26-wp-scan-block.md）
    __WAF_TF__: JSON.stringify(readFileSync(path.join(import.meta.dirname, "../../infra/terraform/envs/prod/waf.tf"), "utf8")),
  },
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
          NOTIFICATION_START_AT: "1",
          MAIL_DAILY_LIMIT: "90",
          // リンクのプレビュー（T-08）
          LINK_PREVIEW_OWN_DOMAINS: "app.test",
          // Sign in with Apple（T-12）。単体テストでは動かす（止めたときは各テストで差し替える）
          APPLE_LOGIN_ENABLED: "1",
          // 問い合わせ（T-24）。偽の値（本物の Slack には送らない。fetch はテストで差し替える）
          CONTACT_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/TEST/TEST/test",
          // アイコンの画像の URL の署名の鍵（T-27）。テスト専用
          AVATAR_URL_KEY: "YXZhdGFyLXRlc3Qta2V5LWF2YXRhci10ZXN0LWtleSE",
          // 行きたいのAI提案（T-29）。偽の値（本物の Claude には送らない。fetch はテストで差し替える）
          ANTHROPIC_API_KEY: "sk-ant-test",
        },
      },
    })),
  ],
  test: { name: "api", setupFiles: ["./test/apply-migrations.ts"] },
});
