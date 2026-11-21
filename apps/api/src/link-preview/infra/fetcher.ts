import type { AppDeps } from "../../env";
import { isPublicAddress } from "../domain/ip";
import { fetchableUrl, type FetchPolicy } from "../domain/url";

// 外部のページ・画像の取得（docs/specs/T-08-link-preview.md「取得」「名前解決の検査」）。
// リダイレクトは自分で追い、毎回 URL と名前解決を検査する。本文は展開後の量で打ち切る

export const MAX_REDIRECTS = 3;
const USER_AGENT = "kokohima-link-preview/1.0";

export type FetchOutcome =
  /** url はリダイレクトを追ったあとの URL */
  | { kind: "ok"; url: string; contentType: string; body: Uint8Array; truncated: boolean }
  /** 取りに行かない・取れない（再試行しても同じ） */
  | { kind: "failed"; status?: number }
  /** 一時的な失敗（再試行で直りうる） */
  | { kind: "transient"; status?: number };

type Options = { accept: string; maxBytes: number; policy: FetchPolicy };

/** 名前解決の検査。公開のアドレスだけなら null、だめなら結果 */
async function checkHost(deps: AppDeps, host: string): Promise<FetchOutcome | null> {
  const resolved = await deps.linkPreview.resolve(deps, host);
  if (resolved.kind === "not_found") return { kind: "failed" };
  if (resolved.kind === "error") return { kind: "transient" };
  if (resolved.addresses.length === 0 || !resolved.addresses.every(isPublicAddress)) return { kind: "failed" };
  return null;
}

/** 本文を maxBytes まで読む。達したら止めて truncated */
async function readBody(res: Response, maxBytes: number) {
  const reader = res.body?.getReader();
  if (!reader) return { body: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - size;
    if (value.byteLength >= remaining) {
      chunks.push(value.subarray(0, remaining));
      size += remaining;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return { body, truncated };
}

/** タイムアウトで中断できる処理。中断したら null */
async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, Math.max(0, ms));
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * URL を取りに行く。URL は呼び出し側で fetchableUrl を通したもの。
 * 1回の取得（本文を読み終えるまで）は timeouts.fetchMs、リダイレクトと名前解決を含む全体は timeouts.totalMs
 */
export async function fetchChecked(deps: AppDeps, startUrl: string, options: Options): Promise<FetchOutcome> {
  const { fetchMs, totalMs } = deps.linkPreview.timeouts;
  const deadline = Date.now() + totalMs;
  const run = async (): Promise<FetchOutcome> => {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      const target = fetchableUrl(url, options.policy);
      if (!target) return { kind: "failed" };
      const hostCheck = await checkHost(deps, target.host);
      if (hostCheck) return hostCheck;
      const left = deadline - Date.now();
      if (left <= 0) return { kind: "transient" };
      const step = await withTimeout(Math.min(fetchMs, left), async (signal): Promise<FetchOutcome | { kind: "redirect"; location: string }> => {
        let res: Response;
        try {
          res = await deps.fetch(target.href, {
            method: "GET",
            redirect: "manual",
            signal,
            headers: { "User-Agent": USER_AGENT, Accept: options.accept, "Accept-Language": "ja" },
          });
        } catch {
          return { kind: "transient" };
        }
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          const location = res.headers.get("Location");
          if (!location) return { kind: "failed", status: res.status };
          try {
            return { kind: "redirect", location: new URL(location, target.href).href };
          } catch {
            return { kind: "failed", status: res.status };
          }
        }
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          const transient = res.status === 429 || res.status >= 500;
          return { kind: transient ? "transient" : "failed", status: res.status };
        }
        try {
          const { body, truncated } = await readBody(res, options.maxBytes);
          return { kind: "ok", url: target.href, contentType: res.headers.get("Content-Type") ?? "", body, truncated };
        } catch {
          return { kind: "transient" };
        }
      });
      if (step === null) return { kind: "transient" };
      if (step.kind !== "redirect") return step;
      if (hop + 1 > MAX_REDIRECTS) return { kind: "failed" };
      url = step.location;
    }
  };
  return (await withTimeout(totalMs, run)) ?? { kind: "transient" };
}
