import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// zod は名前空間で読む（`import { z }` は使わない言語のファイルまで Worker と画面に入る。docs/specs/T-49-perf-small-fixes.md「1.」）
const ZOD_NAMESPACE = {
  name: "zod",
  importNames: ["z"],
  message: 'zod は `import * as z from "zod"` で読む（使わない言語のファイルを木の剪定で落とすため）',
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "playwright-report/**",
      "test-results/**",
      "infra/**",
      // ビルドの出力をまねた fixture（docs/specs/T-19-privacy-terms.md「5.」）
      "apps/api/test/fixtures/**",
      // 外部から取り込んだスキル（.claude/skills/THIRD_PARTY.md）。取り込んだファイルは編集しないので lint しない
      ".claude/skills/security-audit/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { paths: [ZOD_NAMESPACE] }] },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Service Worker（docs/specs/T-07-notification.md）
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // E2E用の経路（テスト用ログインなど）が本番のコードから読み込まれないようにする
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/e2e/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [ZOD_NAMESPACE],
          patterns: [{ group: ["**/e2e", "**/e2e/**"], message: "E2E用のコードは src/e2e/entry.ts からだけ読み込む" }],
        },
      ],
    },
  },
  {
    files: ["*.{js,ts}", "**/scripts/**/*.{js,mjs}", "e2e/**/*.ts", "**/vitest.config.ts", "**/vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
);
