import { useEffect } from "react";
import { useAuth } from "./auth/AuthProvider";
import { AuthCompletePage } from "./pages/AuthCompletePage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { navigate, useLocation } from "./router";

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

export function App() {
  const { pathname, search } = useLocation();
  const { status, retry } = useAuth();

  if (pathname === "/auth/complete") return <AuthCompletePage />;

  if (status === "checking") {
    return (
      <main className="mx-auto max-w-md p-6">
        <p role="status">読み込み中…</p>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <p role="status" className="text-slate-600">
          接続できませんでした。通信状態を確認して、もう一度お試しください。
        </p>
        <button type="button" className="rounded-lg border border-slate-300 px-4 py-3" onClick={retry}>
          もう一度試す
        </button>
      </main>
    );
  }

  if (pathname === "/login") {
    if (status === "authenticated") return <Redirect to="/" />;
    return <LoginPage search={search} />;
  }

  if (status === "anonymous") {
    const returnTo = pathname + search;
    return <Redirect to={returnTo === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`} />;
  }

  return <HomePage />;
}
