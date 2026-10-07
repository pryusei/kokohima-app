import { meResponseSchema } from "@kokohima/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "../api/client";
import { keys } from "../api/keys";
import { useAuth } from "../auth/AuthProvider";

// ログイン後の仮のホーム。最終的なデザインはデザインのタスクで差し替える

export function HomePage() {
  const { logout, logoutAll } = useAuth();
  const [failed, setFailed] = useState(false);
  const run = (action: () => Promise<boolean>) => async () => {
    setFailed(false);
    if (!(await action())) setFailed(true);
  };
  const me = useQuery({ queryKey: keys.me(), queryFn: () => apiGet("/api/v1/me", meResponseSchema) });

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">ここ暇</h1>
      <p role="status">ログイン中</p>
      {me.data && <p className="text-slate-600">{me.data.displayName ?? "表示名は未設定です"}</p>}
      <a className="rounded-lg border border-slate-300 px-4 py-3 text-center" href="/friends">
        友達
      </a>
      {failed && (
        <p role="status" className="text-slate-600">
          ログアウトできませんでした。通信状態を確認して、もう一度お試しください。
        </p>
      )}
      <button type="button" className="rounded-lg border border-slate-300 px-4 py-3" onClick={run(logout)}>
        ログアウト
      </button>
      <button type="button" className="rounded-lg border border-slate-300 px-4 py-3" onClick={run(logoutAll)}>
        すべての端末からログアウト
      </button>
    </main>
  );
}
