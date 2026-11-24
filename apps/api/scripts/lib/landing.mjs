// 紹介のページ（apps/web/dist/landing.html）の検査（docs/specs/T-44-landing.md「5.」）。
// check-web-dist.mjs はファイルを読んで渡すだけ。ファイルを読まない純粋な関数にして、単体テスト（apps/api/test/landing.test.ts）から呼ぶ

/**
 * 紹介のページの問題の一覧。なければ空。
 * @param {string | null} html landing.html の中身。null はファイルがないとき
 * @returns {string[]}
 */
export function landingProblems(html) {
  if (html === null) return ["dist に landing.html がありません（apps/web/vite.config.ts の入口を確かめてください）"];
  const problems = [];
  // JavaScript を置かない（src があっても止める）
  if (/<script\b/i.test(html)) problems.push("landing.html に script があります");
  if (/<style\b/i.test(html)) problems.push("landing.html にインラインの style 要素があります");
  if (/\sstyle\s*=/i.test(html)) problems.push("landing.html に style 属性があります");
  // vite は HTML を圧縮しないので、コメントはそのまま本番に出る（内部の説明を外に出さない）
  if (/<!--/.test(html)) problems.push("landing.html に HTML のコメントがあります");
  // 審査の要件：アプリ名が同意画面と同じ・ログインへの入口・プライバシー ポリシーと利用規約へのリンク
  if (!/<title>\s*ここ暇\s*<\/title>/.test(html)) problems.push("landing.html の <title> が「ここ暇」ではありません");
  if (!/<h1\b[^>]*>[^<]*ここ暇[^<]*<\/h1>/.test(html)) problems.push("landing.html の <h1> に「ここ暇」がありません");
  for (const href of ["/privacy", "/terms", "/login"]) {
    if (!new RegExp(`\\bhref\\s*=\\s*["']${href}["']`).test(html)) problems.push(`landing.html に ${href} へのリンクがありません`);
  }
  // 外のオリジンのものを読まない（mailto: は許す）。// で始まるもの（プロトコル相対）も外とみる
  for (const m of html.matchAll(/\b(src|href|srcset|action)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]*)/gi)) {
    problems.push(`landing.html に外のオリジンを指す ${m[1]} があります（${m[2]}）`);
  }
  return problems;
}
