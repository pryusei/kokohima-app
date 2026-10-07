// アクセストークンはこのモジュールの変数（メモリ）にだけ持つ。
// localStorage・sessionStorage・IndexedDB・Cookie には保存しない（docs/specs/T-01-auth.md）

type Token = { accessToken: string; expiresAt: number };

let current: Token | null = null;
let version = 0;

export const tokenStore = {
  get(): string | null {
    return current && current.expiresAt > Date.now() ? current.accessToken : null;
  },
  set(accessToken: string, expiresAt: string) {
    current = { accessToken, expiresAt: Date.parse(expiresAt) };
    version++;
  },
  clear() {
    current = null;
    version++;
  },
  /** 更新の直列化で「待っている間に他のタブが更新したか」を見分けるための番号 */
  version: () => version,
};
