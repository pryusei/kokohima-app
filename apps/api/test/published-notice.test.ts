import { describe, expect, it } from "vitest";
import { entryScripts, importedScripts, isNoticePublished } from "../scripts/lib/published-notice.mjs";

// 本番に予告の行がもう出ているかの確かめ（docs/specs/T-19-privacy-terms.md「5.」）。fetch は差し替える
const ORIGIN = "https://kokohima.app";
const NOTICE = "公表日：2026年11月25日（この版は改定日から適用します。それまでは、前の版を適用します）";
const html = (src: string) => `<!doctype html><html><head><script type="module" crossorigin src="${src}"></script></head><body></body></html>`;
const res = (body: string, type: string, status = 200) => new Response(body, { status, headers: { "Content-Type": type } });

/** パスごとの応答。ないパスは、本番の SPA の振り分けと同じく index.html を返す */
function site(files: Record<string, Response | (() => Response)>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const f = files[path];
    if (f) return typeof f === "function" ? f() : f.clone();
    return res(html("/assets/index.js"), "text/html; charset=utf-8");
  };
  return { fetch, calls };
}

describe("本番の画面の JS を読む", () => {
  it("index.html の script と modulepreload の、同じオリジンの JS だけ", () => {
    const h = `<script type="module" src="/assets/index-a.js"></script><link rel="modulepreload" href="/assets/vendor-b.js"><script src="https://evil.example/x.js"></script>`;
    expect(entryScripts(h, ORIGIN)).toEqual([`${ORIGIN}/assets/index-a.js`, `${ORIGIN}/assets/vendor-b.js`]);
  });

  it("chunk の import をたどる（./x.js は読む JS から、assets/x.js はオリジンから）", () => {
    const js = `import{a}from"./Privacy-c.js";const m=["assets/Terms-d.js"];import("https://evil.example/e.js")`;
    expect(importedScripts(js, `${ORIGIN}/assets/index-a.js`, ORIGIN)).toEqual([
      `${ORIGIN}/assets/Privacy-c.js`,
      `${ORIGIN}/assets/Terms-d.js`,
    ]);
  });

  it("予告の行がそのまま入っていれば真、なければ偽", async () => {
    const yes = site({ "/": res(html("/assets/index.js"), "text/html"), "/assets/index.js": res(`const N="${NOTICE}";`, "text/javascript") });
    expect(await isNoticePublished(NOTICE, { origin: ORIGIN, fetch: yes.fetch })).toBe(true);
    const old = site({ "/": res(html("/assets/index.js"), "text/html"), "/assets/index.js": res(`const E="制定日：2026年11月23日";`, "text/javascript") });
    expect(await isNoticePublished(NOTICE, { origin: ORIGIN, fetch: old.fetch })).toBe(false);
    // 日付をずらした予告は、別の予告として扱う（初めて出すデプロイになる）
    const shifted = NOTICE.replace("11月25日", "11月26日");
    expect(await isNoticePublished(shifted, { origin: ORIGIN, fetch: yes.fetch })).toBe(false);
  });

  it("遅延読み込みの chunk の中も探す", async () => {
    const s = site({
      "/": res(html("/assets/index.js"), "text/html"),
      "/assets/index.js": res(`import("./legal.js")`, "application/javascript"),
      "/assets/legal.js": res(`const N="${NOTICE}";`, "text/javascript"),
    });
    expect(await isNoticePublished(NOTICE, { origin: ORIGIN, fetch: s.fetch })).toBe(true);
  });

  it("読めない・形が違うときは例外（呼ぶ側で止める）", async () => {
    const cases = [
      site({ "/": res("x", "text/html", 503) }),
      site({ "/": res("{}", "application/json") }),
      site({ "/": res("<html></html>", "text/html") }),
      // ない JS に SPA の振り分けで index.html が返る
      site({ "/": res(html("/assets/missing.js"), "text/html") }),
      site({ "/": res(html("/assets/index.js"), "text/html"), "/assets/index.js": res("", "text/javascript", 404) }),
      site({ "/": () => { throw new TypeError("fetch failed"); } }),
    ];
    for (const s of cases) await expect(isNoticePublished(NOTICE, { origin: ORIGIN, fetch: s.fetch })).rejects.toThrow();
  });
});
