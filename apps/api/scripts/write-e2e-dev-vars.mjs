// E2E用の秘密情報（.dev.vars.e2e）を、なければその場で生成する。コミットしない（docs/specs/T-01-auth.md）
import { webcrypto } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 引数で書き出し先の名前を変えられる（本番と同じ形の E2E の .dev.vars.assets。T-12）。並んで起動するサーバーが同じファイルを取り合わないように
const path = join(dirname(fileURLToPath(import.meta.url)), "..", process.argv[2] ?? ".dev.vars.e2e");
if (!existsSync(path)) {
  const key = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const calendarKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  writeFileSync(
    path,
    [
      `JWT_SIGNING_KEYS='{"e2e-1":"${key}"}'`,
      `CALENDAR_TOKEN_KEYS='{"e2e-1":"${calendarKey}"}'`,
      "GOOGLE_CLIENT_SECRET=e2e-unused",
      "APPLE_PRIVATE_KEY=e2e-unused",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}
// T-06 より前に作ったファイルには、カレンダーの鍵を足す
if (!readFileSync(path, "utf8").includes("CALENDAR_TOKEN_KEYS=")) {
  const calendarKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  appendFileSync(path, `CALENDAR_TOKEN_KEYS='{"e2e-1":"${calendarKey}"}'\n`);
}
// T-07 より前に作ったファイルには、通知の鍵を足す（VAPID の鍵の組、購読の暗号化の鍵、偽の Resend 用の値）
if (!readFileSync(path, "utf8").includes("VAPID_PRIVATE_KEY=")) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const publicRaw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).trim().replace(/\n/g, "\\n");
  const notificationKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  appendFileSync(
    path,
    [
      `VAPID_PRIVATE_KEY="${pem}"`,
      `VAPID_PUBLIC_KEY=${publicRaw}`,
      `NOTIFICATION_KEYS='{"e2e-1":"${notificationKey}"}'`,
      "RESEND_API_KEY=e2e-unused",
      "",
    ].join("\n"),
  );
}
// T-24 より前に作ったファイルには、偽の Slack の webhook を足す（E2E のエントリが slack.e2e.invalid だけを許す）
if (!readFileSync(path, "utf8").includes("CONTACT_SLACK_WEBHOOK_URL=")) {
  appendFileSync(path, "CONTACT_SLACK_WEBHOOK_URL=https://slack.e2e.invalid/services/e2e\n");
}
