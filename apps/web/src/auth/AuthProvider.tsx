import { useQueryClient } from "@tanstack/react-query";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { setUnauthenticatedHandler } from "../api/client";
import { broadcastLogout, onAuthMessage, refreshAccessToken, type RefreshOutcome } from "./refresh";
import { tokenStore } from "./tokenStore";

// ログイン状態。起動時に更新用トークンでアクセストークンを取り直す
// checking：確認中、error：通信できない（ログアウトとは扱わない）

export type AuthStatus = "checking" | "authenticated" | "anonymous" | "error";

type AuthContextValue = {
  status: AuthStatus;
  /** ログインの完了でアクセストークンを受け取ったとき */
  signedIn: (accessToken: string, expiresAt: string) => void;
  retry: () => void;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, skipInitialRefresh = false }: { children: ReactNode; skipInitialRefresh?: boolean }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>(skipInitialRefresh ? "anonymous" : "checking");

  const becomeAnonymous = useCallback(() => {
    tokenStore.clear();
    queryClient.clear();
    setStatus("anonymous");
  }, [queryClient]);

  const applyOutcome = useCallback((outcome: RefreshOutcome) => {
    setStatus(outcome === "ok" ? "authenticated" : outcome === "unauthenticated" ? "anonymous" : "error");
  }, []);

  /** 再試行（ボタンやオンライン復帰から呼ぶ） */
  const check = useCallback(() => {
    setStatus("checking");
    void refreshAccessToken().then(applyOutcome);
  }, [applyOutcome]);

  useEffect(() => {
    setUnauthenticatedHandler(becomeAnonymous);
    const off = onAuthMessage((m) => {
      if (m.type === "logout") becomeAnonymous();
      if (m.type === "token") setStatus("authenticated");
    });
    return off;
  }, [becomeAnonymous]);

  // 起動時：初期状態が checking なので、結果だけを反映する
  useEffect(() => {
    if (skipInitialRefresh) return;
    let cancelled = false;
    void refreshAccessToken().then((outcome) => {
      if (!cancelled) applyOutcome(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [applyOutcome, skipInitialRefresh]);

  // 通信できなかったときは、オンラインに戻ったら自動で確かめ直す
  useEffect(() => {
    if (status !== "error") return;
    const onOnline = () => check();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [status, check]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      signedIn: (accessToken, expiresAt) => {
        tokenStore.set(accessToken, expiresAt);
        setStatus("authenticated");
      },
      retry: check,
      logout: async () => {
        await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
        broadcastLogout();
        becomeAnonymous();
      },
      logoutAll: async () => {
        const token = tokenStore.get();
        await fetch("/api/v1/auth/logout-all", {
          method: "POST",
          credentials: "same-origin",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }).catch(() => undefined);
        broadcastLogout();
        becomeAnonymous();
      },
    }),
    [status, check, becomeAnonymous],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
