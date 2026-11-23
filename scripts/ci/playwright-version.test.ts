import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { playwrightVersion } from "./playwright-version.mjs";

// E2E のコンテナの版を lockfile から決める（docs/specs/T-30-ci-review.md「3. E2E」「テスト計画」）

const lock = (root: string, others = "") => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
${root}
${others}
packages:

  '@playwright/test@9.9.9':
    resolution: {integrity: sha512-x}
`;

const PLAYWRIGHT = `    devDependencies:
      '@eslint/js':
        specifier: ^10.0.1
        version: 10.0.1(eslint@10.14.0(jiti@2.7.0))
      '@playwright/test':
        specifier: ~1.65.0
        version: 1.65.0
      vitest:
        specifier: ^4.1.12
        version: 4.1.12`;

describe("@playwright/test の版", () => {
  it("ルートの devDependencies の版を返す", () => {
    expect(playwrightVersion(lock(PLAYWRIGHT))).toBe("1.65.0");
  });

  it("このリポジトリの pnpm-lock.yaml から読める", () => {
    const real = readFileSync(join(import.meta.dirname, "../../pnpm-lock.yaml"), "utf8");
    expect(playwrightVersion(real)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("ほかの importer にだけあるときは、ルートの版として読まない", () => {
    const others = `  apps/web:
    devDependencies:
      '@playwright/test':
        specifier: ~1.60.0
        version: 1.60.0`;
    expect(() => playwrightVersion(lock(`    devDependencies:\n      vitest:\n        specifier: ^4.1.12\n        version: 4.1.12`, others))).toThrow();
  });

  it("ルートがない・版の形が違うときは止める（違う版のコンテナで回さない）", () => {
    expect(() => playwrightVersion("lockfileVersion: '9.0'\n")).toThrow();
    expect(() => playwrightVersion(lock(PLAYWRIGHT.replace("version: 1.65.0", "version: 1.65.0(foo@1.0.0)")))).toThrow();
  });
});
