// E2E用の秘密情報（.dev.vars.e2e）を、なければその場で生成する。コミットしない（docs/specs/T-01-auth.md）
import { webcrypto } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars.e2e");
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
