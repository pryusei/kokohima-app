import { defineConfig } from "vitest/config";

// ルートの `pnpm test [path]` で全パッケージのテストを実行する
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
