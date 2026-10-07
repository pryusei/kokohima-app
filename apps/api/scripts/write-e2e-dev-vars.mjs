// E2E用の秘密情報（.dev.vars.e2e）を、なければその場で生成する。コミットしない（docs/specs/T-01-auth.md）
import { webcrypto } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars.e2e");
if (!existsSync(path)) {
  const key = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  writeFileSync(
    path,
    [
      `JWT_SIGNING_KEYS='{"e2e-1":"${key}"}'`,
      "GOOGLE_CLIENT_SECRET=e2e-unused",
      "APPLE_PRIVATE_KEY=e2e-unused",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}
