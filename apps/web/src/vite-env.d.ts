/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sign in with Apple のボタンを出すか（"1" のときだけ。T-12） */
  readonly VITE_APPLE_LOGIN_ENABLED?: string;
}

/** 問い合わせを公開の日によらずに開く（E2E=1 の vite だけ true。本番のビルドでは false。docs/specs/T-24-contact.md「振る舞い 11.」） */
declare const __CONTACT_FORCE_OPEN__: boolean;
