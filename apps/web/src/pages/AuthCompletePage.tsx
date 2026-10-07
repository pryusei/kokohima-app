import { authCompleteResponseSchema } from "@kokohima/shared";
import { useEffect, useRef } from "react";
import { useAuth } from "../auth/AuthProvider";
import { navigate } from "../router";

// プロバイダから戻ってきた後、同じオリジンの fetch でログインを完了させる（docs/specs/T-01-auth.md）

export function readAndClearCode(): string | null {
  const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
  // コードはすぐURLから消す（履歴や画面共有に残さない）
  window.history.replaceState(null, "", window.location.pathname);
  return code;
}

export function AuthCompletePage() {
  const { signedIn } = useAuth();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = readAndClearCode();
    const fail = () => navigate("/login?error=login_failed", { replace: true });
    if (!code) return fail();
    void (async () => {
      try {
        const res = await fetch("/api/v1/auth/complete", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const parsed = authCompleteResponseSchema.safeParse(res.ok ? await res.json() : null);
        if (!parsed.success) return fail();
        signedIn(parsed.data.accessToken, parsed.data.expiresAt);
        navigate(parsed.data.returnTo, { replace: true });
      } catch {
        fail();
      }
    })();
  }, [signedIn]);

  return (
    <main className="mx-auto max-w-md p-6">
      <p role="status">ログインしています…</p>
    </main>
  );
}
