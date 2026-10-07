// ログイン画面（仮）。最終的なデザインはデザインのタスクで差し替える

export function LoginPage({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  const failed = params.get("error") === "login_failed";
  const returnTo = params.get("returnTo") ?? "/";
  const startUrl = (provider: "google" | "apple") =>
    `/api/v1/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">ここ暇</h1>
      <h2 className="text-lg">ログイン</h2>
      {failed && (
        // 断りや失敗は赤やエラー色で驚かせない
        <p role="status" className="text-slate-600">
          ログインできませんでした。もう一度お試しください。
        </p>
      )}
      <a className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-center" href={startUrl("google")}>
        Googleでログイン
      </a>
      <a className="rounded-lg bg-black px-4 py-3 text-center text-white" href={startUrl("apple")}>
        Appleでログイン
      </a>
    </main>
  );
}
