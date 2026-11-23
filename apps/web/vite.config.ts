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
