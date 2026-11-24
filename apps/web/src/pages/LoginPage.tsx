import { isLineInAppBrowser, withOpenExternalBrowser } from "../line/line";
import { LineBrowserNotice } from "../line/LineBrowserNotice";
import { LoginButtons } from "../auth/LoginButtons";
import { LegalLinks } from "./LegalDocument";
// ログイン画面（docs/specs/T-01-auth.md、キャンバス「2 ログイン」）

export function LoginPage({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  const failed = params.get("error") === "login_failed";
  const withdrawn = params.get("withdrawn") === "1";
  const returnTo = params.get("returnTo") ?? "/";

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
          今まで使ってくれてありがとう。またいつでも待ってるね。
        </p>
      )}
      {failed && (
        // 断りや失敗は赤やエラー色で驚かせない
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          ログインできませんでした。もう一度お試しください。
        </p>
      )}
      {isLineInAppBrowser() && (
        <LineBrowserNotice reopenHref={withOpenExternalBrowser(`${window.location.pathname}${search}`)} />
      )}
      <LoginButtons returnTo={returnTo} />
      {/* 同意はこの1行で取る。チェックボックスも同意の記録もない（docs/specs/T-19-privacy-terms.md 決めたこと7） */}
      <LegalLinks consent />
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
