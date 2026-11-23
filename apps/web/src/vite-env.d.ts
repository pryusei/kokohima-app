/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sign in with Apple のボタンを出すか（"1" のときだけ。T-12） */
  readonly VITE_APPLE_LOGIN_ENABLED?: string;
}
