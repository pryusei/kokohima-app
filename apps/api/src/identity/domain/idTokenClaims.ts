// IDトークンの検証済みクレームから、保存してよいメールアドレスを取り出す

export type Provider = "google" | "apple" | "e2e";

export type VerifiedClaims = {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
};

/** 確認済みのメールアドレスだけを返す。Appleは email_verified を文字列 "true" で返すことがある */
export function verifiedEmail(provider: Provider, claims: VerifiedClaims): string | null {
  if (typeof claims.email !== "string" || claims.email.length === 0 || claims.email.length > 320) {
    return null;
  }
  const v = claims.email_verified;
  const verified = provider === "apple" ? v === true || v === "true" : v === true;
  return verified ? claims.email : null;
}
