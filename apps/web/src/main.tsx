import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { createQueryClient } from "./queryClient";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      {/* ログインの完了画面では、完了のAPIがトークンを返すので起動時の更新はしない */}
      <AuthProvider skipInitialRefresh={window.location.pathname === "/auth/complete"}>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
