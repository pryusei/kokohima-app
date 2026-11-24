import { buttonClass } from "../ui/Button";

// ログインのボタン（docs/specs/T-32-line-login.md「6. 画面」）。ログインの画面と招待の受け口で同じ並びにする。
// LINE を最初に置く（招待は LINE で届き、LINE の中のブラウザでも外に出ずにログインできるため）。Google は残す

export type LoginProvider = "line" | "google" | "apple";

export const loginStartUrl = (provider: LoginProvider, returnTo: string) =>
  `/api/v1/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`;

export function LoginButtons({ returnTo }: { returnTo: string }) {
  return (
    <div className="flex flex-col gap-2">
      {/* LINE の決まりの色（緑の地に白の太字）。トークンは index.css の brand-line */}
      <a
        data-provider="line-login"
        className={`${buttonClass("secondary", { block: true })} border-transparent bg-brand-line text-on-brand-line`}
        href={loginStartUrl("line", returnTo)}
      >
        LINEでログイン
      </a>
      <a className={buttonClass("secondary", { block: true })} href={loginStartUrl("google", returnTo)}>
        Googleでログイン
      </a>
      {/* Sign in with Apple は VITE_APPLE_LOGIN_ENABLED が "1" のときだけ（T-12）。本番のビルドでは文字列ごと落ちる */}
      {import.meta.env.VITE_APPLE_LOGIN_ENABLED === "1" && (
        <a
          data-provider="apple-login"
          className={`${buttonClass("secondary", { block: true })} border-transparent bg-ink text-surface`}
          href={loginStartUrl("apple", returnTo)}
        >
          Appleでログイン
        </a>
      )}
    </div>
  );
}
