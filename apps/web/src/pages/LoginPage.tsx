import { buttonClass } from "../ui/Button";
// ログイン画面（docs/specs/T-01-auth.md、キャンバス「2 ログイン」）

export function LoginPage({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  const failed = params.get("error") === "login_failed";
  const withdrawn = params.get("withdrawn") === "1";
  const returnTo = params.get("returnTo") ?? "/";
  const startUrl = (provider: "google" | "apple") =>
    `/api/v1/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-12">
      <div className="flex flex-col gap-4">
        <Windows />
        <h1 className="text-xxl font-bold">ここ暇</h1>
        <p className="text-ink-muted">
          この時間なら、誘っていいよ。
          <br />
          暇な時間を友達に見せて、気軽に誘い合えます。
        </p>
      </div>
      <h2 className="sr-only">ログイン</h2>
      {withdrawn && (
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          退会しました。
        </p>
      )}
      {failed && (
        // 断りや失敗は赤やエラー色で驚かせない
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          ログインできませんでした。もう一度お試しください。
        </p>
      )}
      <div className="flex flex-col gap-2">
        <a className={buttonClass("secondary", { block: true })} href={startUrl("google")}>
          Googleでログイン
        </a>
        {/* Sign in with Apple は VITE_APPLE_LOGIN_ENABLED が "1" のときだけ（T-12）。本番のビルドでは文字列ごと落ちる */}
        {import.meta.env.VITE_APPLE_LOGIN_ENABLED === "1" && (
          <a
            data-provider="apple-login"
            className={`${buttonClass("secondary", { block: true })} border-transparent bg-ink text-surface`}
            href={startUrl("apple")}
          >
            Appleでログイン
          </a>
        )}
      </div>
    </main>
  );
}

/** 夜の窓。いくつかだけ灯っている（表紙と同じ形） */
export function Windows() {
  const lit = [1, 5];
  return (
    <div aria-hidden="true" className="grid w-fit grid-cols-3 gap-2">
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={`h-5 w-7 rounded-s ${lit.includes(i) ? "bg-lamp" : "bg-line"}`} />
      ))}
    </div>
  );
}
