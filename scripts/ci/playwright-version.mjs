// pnpm-lock.yaml で解決した @playwright/test の版を出す（docs/specs/T-30-ci-review.md「3. E2E」）。
// E2E は、この版の Playwright の公式のコンテナで回す。ブラウザの版を lockfile と常に一致させるため。
// 依存のパッケージを使わない（pnpm install の前に動かす）
//
//   node scripts/ci/playwright-version.mjs   版を出す（GITHUB_OUTPUT があれば playwright=<版> を書く）
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** lockfile のルート（importers の `.`）の devDependencies・dependencies にある @playwright/test の版。見つからなければエラー */
export function playwrightVersion(lock) {
  const lines = lock.split("\n");
  const importers = lines.indexOf("importers:");
  const root = importers < 0 ? -1 : lines.indexOf("  .:", importers);
  if (root < 0) throw new Error("pnpm-lock.yaml にルート（importers の .）がありません");
  // ルートの塊は、次の importer（2文字下げの行）か、上の階層のキーまで
  const end = lines.findIndex((line, i) => i > root && /^ {0,2}\S/.test(line));
  const block = lines.slice(root + 1, end < 0 ? undefined : end);
  const at = block.findIndex((line) => /^ {6}'?@playwright\/test'?:$/.test(line));
  const version = at < 0 ? undefined : /^ {8}version: (\S+)$/.exec(block[at + 2] ?? "")?.[1];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("pnpm-lock.yaml のルートに @playwright/test の版がありません（違う版のコンテナで回さないように止める）");
  }
  return version;
}

function main() {
  const lockPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "pnpm-lock.yaml");
  const version = playwrightVersion(readFileSync(lockPath, "utf8"));
  console.log(`@playwright/test：${version}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `playwright=${version}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
