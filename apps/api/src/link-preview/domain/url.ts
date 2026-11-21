// 取りに行ってよい URL（docs/specs/T-08-link-preview.md「取りに行ってよい URL」）。
// WHATWG URL で解析した後の値で判定する。純粋な関数で、設定は引数で受け取る

type ParsedUrl = {
  protocol: string;
  hostname: string;
  port: string;
  username: string;
  password: string;
  href: string;
  hash: string;
};
const UrlCtor = (globalThis as unknown as { URL: new (input: string, base?: string) => ParsedUrl }).URL;

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".test", ".invalid", ".example", ".onion"];
const BLOCKED_DOMAINS = ["localhost", "workers.dev"];

export type FetchPolicy = {
  /** アプリ自身の登録ドメイン（小文字）。そのドメインとサブドメインは取らない */
  ownDomains: readonly string[];
  /** 追加で許すホスト（E2E の偽のサイトだけ。本番は空） */
  extraHosts: readonly string[];
};

/** 一時的な失敗（再試行で直りうる）。Queue の再試行に任せるために投げる */
export class TransientError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TransientError";
  }
}

/** `LINK_PREVIEW_OWN_DOMAINS` を読む。空・読めない値は null（取りに行かない） */
export function parseOwnDomains(value: string | undefined): string[] | null {
  if (!value) return null;
  const domains = value.split(",").map((d) => d.trim());
  const valid = (d: string) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(d);
  if (domains.length === 0 || !domains.every(valid)) return null;
  return domains;
}

const isUnder = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** IPv4 の形（解析の後は 10進の4つ組に正規化される）か IPv6（[...]）か */
const isIpLiteral = (host: string) => host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host);

/** フラグメントを除いた URL。解析できなければ null */
export function withoutFragment(raw: string, base?: string): string | null {
  try {
    const url = new UrlCtor(raw, base);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 取りに行ってよい URL なら、正規化した URL（フラグメントなし）とホスト名（末尾の . を除く）。だめなら null。
 * base を渡すと、相対の URL を絶対にしてから判定する（リダイレクトの Location、og:image）
 */
export function fetchableUrl(raw: string, policy: FetchPolicy, base?: string): { href: string; host: string } | null {
  let url: ParsedUrl;
  try {
    url = new UrlCtor(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const defaultPort = url.protocol === "http:" ? "80" : "443";
  if (url.port !== "" && url.port !== defaultPort) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || isIpLiteral(host)) return null;
  url.hash = "";
  if (policy.extraHosts.includes(host)) return { href: url.href, host };
  if (!host.includes(".")) return null;
  if (BLOCKED_DOMAINS.some((d) => isUnder(host, d))) return null;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return null;
  if (policy.ownDomains.some((d) => isUnder(host, d))) return null;
  return { href: url.href, host };
}
