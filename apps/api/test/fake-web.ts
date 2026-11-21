// リンクのプレビューのテスト用の偽のサイトと偽の DNS over HTTPS（docs/specs/T-08-link-preview.md「テスト計画」）
// ページは URL ごとに応答の作り方を登録する。名前解決はホストごとに A・AAAA の答えを登録する

export type WebRequest = { url: string; init: RequestInit | undefined };
type Handler = (req: WebRequest) => Response | Promise<Response>;
type DnsAnswer = { status?: number; a?: string[]; aaaa?: string[]; answers?: { type: number; data: unknown }[]; fail?: boolean };

export function createFakeWeb() {
  const pages = new Map<string, Handler>();
  const dns = new Map<string, DnsAnswer>();
  const requests: WebRequest[] = [];
  const dnsQueries: string[] = [];

  function handles(url: URL) {
    return url.host === "cloudflare-dns.com" || [...pages.keys()].some((k) => new URL(k).host === url.host);
  }

  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    if (url.host === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type");
      dnsQueries.push(`${name}/${type}`);
      const a = dns.get(name) ?? { status: 3 };
      if (a.fail) return new Response("err", { status: 502 });
      const answers =
        a.answers ??
        (type === "A" ? (a.a ?? []).map((data) => ({ type: 1, data })) : (a.aaaa ?? []).map((data) => ({ type: 28, data })));
      return Response.json({ Status: a.status ?? 0, Answer: answers });
    }
    requests.push({ url: url.href, init });
    const page = pages.get(url.href);
    if (!page) return new Response("not found", { status: 404 });
    return page({ url: url.href, init });
  }

  /** ページの応答を登録し、そのホストを公開のアドレスに引けるようにする */
  function page(url: string, handler: Handler, addresses: DnsAnswer = { a: ["93.184.216.34"] }) {
    pages.set(new URL(url).href, handler);
    const host = new URL(url).hostname;
    if (!dns.has(host)) dns.set(host, addresses);
  }

  return {
    handles,
    handle,
    page,
    dns,
    requests,
    dnsQueries,
    /** そのホストへの取得の回数 */
    countFor: (host: string) => requests.filter((r) => new URL(r.url).hostname === host).length,
  };
}

export const html = (head: string, init: ResponseInit & { contentType?: string } = {}) =>
  new Response(`<!doctype html><html><head>${head}</head><body>本文</body></html>`, {
    status: init.status ?? 200,
    headers: { "Content-Type": init.contentType ?? "text/html; charset=utf-8", ...(init.headers as Record<string, string>) },
  });
