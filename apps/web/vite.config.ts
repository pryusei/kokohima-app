import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// HTTPS で出すとき（iphone の E2E）は、Origin を https://localhost:5174 にした別の API（:8789）へ中継する（docs/specs/T-21-webkit-e2e.md）
const https = process.env.E2E_HTTPS === "1";
const api = https ? "http://localhost:8789" : "http://localhost:8787";

export default defineConfig({
  // E2E_HTTPS=1 のときだけ、自己署名の証明書の HTTPS で出す。WebKit は http://localhost では
  // __Host- の Secure の Cookie を保存しないので、iphone（WebKit）の E2E はこちらで回す（docs/specs/T-21-webkit-e2e.md）
  plugins: [react(), tailwindcss(), ...(https ? [basicSsl()] : [])],
  // 問い合わせの公開の日（docs/specs/T-24-contact.md「振る舞い 11.」）。E2E の画面だけは開いた扱い。本番のビルドと Vitest では false
  // ブロックと通報を始める日（docs/specs/T-33-block-report.md「振る舞い 8.」）も同じ
  define: {
    __CONTACT_FORCE_OPEN__: JSON.stringify(process.env.E2E === "1"),
    __SAFETY_FORCE_OPEN__: JSON.stringify(process.env.E2E === "1"),
  },
  server: {
    port: 5173,
    strictPort: true,
    // API（wrangler dev）へ同一オリジンとして中継する。E2E=1 のときだけテスト用ログインの経路も中継する
    proxy: {
      "/api": api,
      ...(process.env.E2E === "1" ? { "/__e2e__": api } : {}),
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
