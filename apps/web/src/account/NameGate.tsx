import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { Button } from "../ui/Button";
import { Loading, Note } from "../ui/feedback";
import { DisplayNameForm } from "./DisplayNameForm";
import { meQuery } from "./me";

// 名前の画面（docs/specs/T-31-display-name-first-step.md「名前の画面（招待を経由しないとき）」）
// 表示名が空のあいだは、開こうとした画面の代わりに出す。URL は変えないので、保存すると開こうとした画面がそのまま出る

function NamePage() {
  const { logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <p className="font-bold text-ink-muted">ここ暇</p>
      <h1 className="text-xl font-bold">表示名を決めてください</h1>
      <Note>友達に見える名前で、あとで設定から変えられます。</Note>
      <DisplayNameForm submitLabel="これで始める" />
      <Button
        variant="ghost"
        disabled={loggingOut}
        onClick={() => {
          setLoggingOut(true);
          setFailed(false);
          void logout().then((ok) => {
            setLoggingOut(false);
            if (!ok) setFailed(true);
          });
        }}
      >
        ログアウト
      </Button>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          ログアウトできませんでした。通信状態を確認して、もう一度お試しください。
        </p>
      )}
    </main>
  );
}

/** ログイン済みの画面の前に置く。読み込めなかったときは止めない */
export function NameGate({ children }: { children: ReactNode }) {
  const me = useQuery(meQuery());
  // 読み込み中で止めるのは最初の1回だけ。読み込めなかったあとに、ほかの画面の取り直しで止めて画面を描き直さないため
  const [settled, setSettled] = useState(false);
  if (!me.isPending && !settled) setSettled(true);
  if (me.isPending && !settled) {
    return (
      <main className="mx-auto max-w-md p-6">
        <Loading />
      </main>
    );
  }
  if (me.data?.displayName === null) return <NamePage />;
  return children;
}
