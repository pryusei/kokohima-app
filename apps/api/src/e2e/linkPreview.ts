import type { AppDeps } from "../env";

// E2E用の偽のサイト（docs/specs/T-08-link-preview.md「E2E用の偽のサイト」）。src/e2e/entry.ts からだけ読み込む
// .invalid は取りに行ってよい URL ではないので、E2E のエントリだけ AppDeps でこのホストを許し、名前解決も偽物にする

export const E2E_OGP_HOST = "ogp.e2e.invalid";

/** 1×1 の PNG */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** 偽のサイトへの fetch を受ける。ほかの宛先なら null */
export function e2eOgpFetch(url: URL): Response | null {
  if (url.host !== E2E_OGP_HOST) return null;
  if (url.pathname === "/page") {
    const head = `<meta property="og:title" content="E2E のお店"><meta property="og:description" content="駅から3分のお店です"><meta property="og:site_name" content="E2E サイト"><meta property="og:image" content="/og.png">`;
    return new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/og.png") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
  return new Response("not found", { status: 404 });
}

export const E2E_LINK_PREVIEW_DEPS = (base: AppDeps["linkPreview"]): AppDeps["linkPreview"] => ({
  ...base,
  extraHosts: [E2E_OGP_HOST],
  // 偽のサイトのホストだけ、公開のアドレス（文書用でない実在の範囲）に引けたことにする
  resolve: (deps, host) => (host === E2E_OGP_HOST ? Promise.resolve({ kind: "ok", addresses: ["93.184.216.34"] }) : base.resolve(deps, host)),
});
