// 本番の画面に、予告の行（REVISION_NOTICE_LINE）がもう出ているかを確かめる（docs/specs/T-19-privacy-terms.md「5.」）。
// deploy:prod（check-web-dist.mjs --deploy）だけが使う。問い合わせ（T-24）の変更がもう本番に出ているかも、同じ読み方で確かめる。出ていなければ、このデプロイが初めて予告を出すので、公表日は今日でなければならない。
// 読めない・形が違うときは例外を投げる（呼ぶ側で止める。通さない）。fetch はテストのために差し替えられる

/** 本番の画面のオリジン（apps/api/wrangler.jsonc の prod の routes・APP_ORIGIN） */
export const PRODUCTION_ORIGIN = "https://kokohima.app";
/** 読む JS のファイルの数の上限（これを超えたら、形が違うとして止める） */
export const MAX_SCRIPT_FILES = 50;

/** index.html が読み込む同じオリジンの JS（script の src と modulepreload の href） */
export function entryScripts(html, origin) {
  const urls = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) urls.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) urls.push(m[1]);
  return sameOriginJs(urls, `${origin}/`, origin);
}

/** JS が読み込む、ほかの chunk（"./x.js"・"/assets/x.js"・"assets/x.js"） */
export function importedScripts(js, scriptUrl, origin) {
  const urls = [];
  for (const m of js.matchAll(/["'`]((?:\.\/|\/)?(?:assets\/)?[\w.-]+\.js)["'`]/g)) {
    const ref = m[1];
    if (ref.startsWith("./")) urls.push(new URL(ref, scriptUrl).href);
    else if (ref.startsWith("/") || ref.startsWith("assets/")) urls.push(new URL(ref, `${origin}/`).href);
  }
  return sameOriginJs(urls, scriptUrl, origin);
}

function sameOriginJs(refs, base, origin) {
  return refs
    .map((r) => new URL(r, base))
    .filter((u) => u.origin === origin && u.pathname.endsWith(".js"))
    .map((u) => u.href);
}

async function get(f, url, type) {
  const res = await f(url, { redirect: "error", headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!type.test(contentType)) throw new Error(`${url} の Content-Type が ${contentType || "ありません"}`);
  return res.text();
}

/**
 * 本番の画面の JS に、needles のそれぞれがそのまま入っているか（needle → 真偽）。すべて見つかったら読むのをやめる。
 * 読めない・形が違うときは例外を投げる（呼ぶ側で止める）
 */
export async function findPublishedStrings(needles, { origin = PRODUCTION_ORIGIN, fetch: f = fetch } = {}) {
  const found = new Map(needles.map((n) => [n, false]));
  const html = await get(f, `${origin}/`, /^text\/html\b/i);
  const queue = entryScripts(html, origin);
  if (queue.length === 0) throw new Error(`${origin}/ に同じオリジンの script がありません`);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const url = queue.shift();
    // SPA の振り分けで、ない JS にも index.html が返るので、Content-Type で確かめる
    const js = await get(f, url, /^(text|application)\/javascript\b/i);
    for (const n of needles) if (js.includes(n)) found.set(n, true);
    if ([...found.values()].every(Boolean)) return found;
    for (const next of importedScripts(js, url, origin)) {
      if (seen.has(next)) continue;
      if (seen.size >= MAX_SCRIPT_FILES) throw new Error(`読む JS が ${MAX_SCRIPT_FILES} を超えました`);
      seen.add(next);
      queue.push(next);
    }
  }
  return found;
}

/** 本番の画面の JS に noticeLine（予告の行の全体）がそのまま入っているか */
export async function isNoticePublished(noticeLine, options = {}) {
  return (await findPublishedStrings([noticeLine], options)).get(noticeLine) === true;
}
