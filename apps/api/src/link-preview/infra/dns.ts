import type { AppDeps, ResolveResult } from "../../env";

// 名前解決（DNS over HTTPS。docs/specs/T-08-link-preview.md「名前解決の検査」）。A・AAAA の両方を引き、
// type 1（A）と 28（AAAA）の data だけを返す。NXDOMAIN は not_found、SERVFAIL・タイムアウト・読めない応答は error

export const DOH_URL = "https://cloudflare-dns.com/dns-query";

type DohAnswer = { type?: unknown; data?: unknown };
type DohResponse = { Status?: unknown; Answer?: unknown };

async function query(deps: AppDeps, host: string, type: "A" | "AAAA"): Promise<ResolveResult> {
  const url = new URL(DOH_URL);
  url.searchParams.set("name", host);
  url.searchParams.set("type", type);
  let body: DohResponse;
  try {
    const res = await deps.fetch(url.toString(), {
      headers: { Accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(deps.linkPreview.timeouts.dnsMs),
    });
    if (res.status !== 200) return { kind: "error" };
    body = (await res.json()) as DohResponse;
  } catch {
    return { kind: "error" };
  }
  if (body.Status === 3) return { kind: "not_found" };
  if (body.Status !== 0) return { kind: "error" };
  const answers = Array.isArray(body.Answer) ? (body.Answer as DohAnswer[]) : [];
  const addresses: string[] = [];
  for (const a of answers) {
    if (a.type !== 1 && a.type !== 28) continue;
    // 読めない値はそのまま返し、検査で拒ませる（fail closed）
    addresses.push(typeof a.data === "string" ? a.data : "");
  }
  return { kind: "ok", addresses };
}

/** A・AAAA の両方を引く。どちらかが error なら error。どちらも NXDOMAIN なら not_found */
export async function resolveDoh(deps: AppDeps, host: string): Promise<ResolveResult> {
  const [a, aaaa] = await Promise.all([query(deps, host, "A"), query(deps, host, "AAAA")]);
  if (a.kind === "error" || aaaa.kind === "error") return { kind: "error" };
  if (a.kind === "not_found" && aaaa.kind === "not_found") return { kind: "not_found" };
  return { kind: "ok", addresses: [...(a.kind === "ok" ? a.addresses : []), ...(aaaa.kind === "ok" ? aaaa.addresses : [])] };
}
