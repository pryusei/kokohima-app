import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

// 認証状態はテストの間で使い回さない。更新用トークンはページを開くたびに交換され、
// 同じトークンを別のテストが送ると再利用として系列ごと失効するため（docs/specs/T-01-auth.md）

/** テスト用ログインで、このコンテキスト専用の新しいセッションを作る */
export async function loginAs(context: BrowserContext, name: string): Promise<string> {
  const user = `${name}-${crypto.randomUUID()}`;
  const res = await context.request.post("/__e2e__/login", { data: { user } });
  expect(res.status()).toBe(204);
  return user;
}

export const test = base.extend<{ loggedInPage: Page }>({
  /** ユーザーAとしてログイン済みのページ */
  loggedInPage: async ({ context, page }, use) => {
    await loginAs(context, "a");
    await use(page);
  },
});

export { expect };
