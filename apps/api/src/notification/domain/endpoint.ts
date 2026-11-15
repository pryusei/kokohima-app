// プッシュの endpoint の検証（docs/specs/T-07-notification.md「入力」）。サーバーがこの URL に POST するので、
// 知られたプッシュのサービスのホストだけを受け付ける（SSRF 対策）。登録のときと、送る直前の両方で使う

const EXACT_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const SUFFIXES = [".push.apple.com", ".notify.windows.com"];
const MAX_LENGTH = 2048;

type UrlLike = { protocol: string; hostname: string; port: string; username: string; password: string; origin: string };
const parse = (value: string): UrlLike | null => {
  try {
    return new (globalThis as unknown as { URL: new (v: string) => UrlLike }).URL(value);
  } catch {
    return null;
  }
};

const isIpAddress = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");

/** 受け付ける endpoint なら、その URL のオリジン（VAPID の aud）。受け付けないなら null */
export function pushEndpointOrigin(endpoint: string, extraHosts: readonly string[] = []): string | null {
  if (endpoint.length === 0 || endpoint.length > MAX_LENGTH) return null;
  const url = parse(endpoint);
  if (!url) return null;
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (isIpAddress(host)) return null;
  const allowed =
    EXACT_HOSTS.includes(host) || extraHosts.includes(host) || SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
  return allowed ? url.origin : null;
}
