import type { AppDeps, Bindings } from "../env";

// 外部の結果のキャッシュ（KV。docs/specs/T-10-idempotency-cache-ratelimit.md「キャッシュ」）
// KV は少し古くてもよい読み取りにだけ使う。読み書きの失敗は無視し、キャッシュがなくても動く
// 置くのは空き／埋まりの時刻や公開されているページの情報だけ（トークン・メールアドレス・誘いの中身は置かない）

type Ctx = { env: Bindings; deps: AppDeps };

export async function cached<T>(ctx: Ctx, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const kv = ctx.deps.cacheEnabled ? (ctx.env.CACHE ?? null) : null;
  if (kv) {
    try {
      const hit = await kv.get<T>(key, "json");
      if (hit !== null) return hit;
    } catch {
      // 読めなければ取り直す
    }
  }
  const value = await load();
  if (kv) {
    try {
      await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
    } catch {
      // 書けなくても結果は返す
    }
  }
  return value;
}
