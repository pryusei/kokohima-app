import { describe, expect, it } from "vitest";
import { landingProblems } from "../scripts/lib/landing.mjs";

// 紹介のページのビルドの検査（docs/specs/T-44-landing.md「5.」）。check-web-dist.mjs が dist/landing.html を読んで渡す

const OK = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><title>ここ暇</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" crossorigin href="/assets/index-a.css"></head>
<body><header><img src="/icon.svg" alt=""><h1 class="text-xxl">ここ暇</h1></header>
<main><p><a href="/login" class="inline-flex">はじめる・ログイン</a></p></main>
<footer><a href="/privacy">プライバシー ポリシー</a><a href="/terms">利用規約</a><a href="mailto:ops@kokohima.app">ops@kokohima.app</a></footer></body></html>`;

describe("紹介のページの検査", () => {
  it("正しい landing.html は通る（mailto: は外のオリジンとみない）", () => {
    expect(landingProblems(OK)).toEqual([]);
  });

  it("landing.html がないと止まる", () => {
    expect(landingProblems(null)).toEqual([expect.stringContaining("landing.html がありません")]);
  });

  it("script があると止まる（src があっても、インラインでも）", () => {
    expect(landingProblems(OK.replace("</head>", `<script type="module" src="/assets/a.js"></script></head>`))).toEqual([
      expect.stringContaining("script"),
    ]);
    expect(landingProblems(OK.replace("</body>", "<SCRIPT>1</SCRIPT></body>"))).toEqual([expect.stringContaining("script")]);
  });

  it("インラインの style 要素・style 属性があると止まる", () => {
    expect(landingProblems(OK.replace("</head>", "<style>a{}</style></head>"))).toEqual([expect.stringContaining("style 要素")]);
    expect(landingProblems(OK.replace(`<h1 class="text-xxl">`, `<h1 style="color:red">`))).toEqual([expect.stringContaining("style 属性")]);
  });

  it("<title> が「ここ暇」でない・<h1> に「ここ暇」がないと止まる", () => {
    expect(landingProblems(OK.replace("<title>ここ暇</title>", "<title>Kokohima</title>"))).toEqual([expect.stringContaining("<title>")]);
    expect(landingProblems(OK.replace(`<h1 class="text-xxl">ここ暇</h1>`, "<h1>Kokohima</h1>"))).toEqual([expect.stringContaining("<h1>")]);
  });

  it("/privacy・/terms・/login へのリンクがないと、それぞれで止まる", () => {
    for (const href of ["/privacy", "/terms", "/login"]) {
      expect(landingProblems(OK.replace(`href="${href}"`, `href="${href}x"`)), href).toEqual([expect.stringContaining(`${href} へのリンク`)]);
    }
  });

  it("外のオリジンを指す src・href（http・https・プロトコル相対）があると止まる", () => {
    for (const tag of [
      `<img src="https://cdn.example/a.png">`,
      `<link rel="stylesheet" href="http://fonts.example/a.css">`,
      `<img src="//cdn.example/p.gif">`,
    ]) {
      expect(landingProblems(OK.replace("</body>", `${tag}</body>`)), tag).toEqual([expect.stringContaining("外のオリジン")]);
    }
  });
});
