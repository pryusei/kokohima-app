import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // API（wrangler dev）へ同一オリジンとして中継する。E2E=1 のときだけテスト用ログインの経路も中継する
    proxy: {
      "/api": "http://localhost:8787",
      ...(process.env.E2E === "1" ? { "/__e2e__": "http://localhost:8787" } : {}),
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
