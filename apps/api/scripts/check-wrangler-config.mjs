// wrangler の設定の検査（docs/specs/T-12-release.md「ビルドとデプロイのコマンド」）。
// 設定が変わって、画面がヘッダーなしで返ったり、workers.dev に公開されたりするのを CI で気づくため
// --deploy（deploy:prod だけで付ける）：prod の転記を忘れた値（空の vars、すべて0の D1・KV の ID）が残っていたら止める。
// CI の build:prod は TODO のままの設定でビルドするので、この検査は付けない
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const path = join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc");
const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
if (parsed.error) {
  console.error("::error::wrangler.jsonc を読めません");
  process.exit(1);
}
const c = parsed.config;
const prod = c.env?.prod ?? {};
const e2e = c.env?.e2e ?? {};
const errors = [];
const expect = (ok, message) => {
  if (!ok) errors.push(message);
};

expect(c.main === "src/index.ts", "トップレベルの main は src/index.ts（本番のエントリ）");
expect((prod.main ?? c.main) === "src/index.ts", "prod の main は src/index.ts（E2E 用のエントリを本番に出さない）");
expect(c.workers_dev === false, "トップレベルの workers_dev は false");
expect(c.preview_urls === false, "トップレベルの preview_urls は false");
expect(prod.workers_dev === false, "prod の workers_dev は false");
expect(prod.preview_urls === false, "prod の preview_urls は false");
expect(prod.assets?.run_worker_first === true, "prod の assets.run_worker_first は true（ヘッダーをコードで付けるため）");
expect(prod.assets?.not_found_handling === "single-page-application", "prod の assets.not_found_handling は single-page-application");
expect(prod.assets?.binding === "ASSETS", "prod の assets.binding は ASSETS");
expect(
  Array.isArray(prod.routes) &&
    prod.routes.length === 1 &&
    prod.routes[0]?.pattern === "kokohima.app" &&
    prod.routes[0]?.custom_domain === true,
  "prod の routes は kokohima.app（custom_domain）だけ",
);
expect(prod.vars?.APPLE_LOGIN_ENABLED === "0", "prod の APPLE_LOGIN_ENABLED は \"0\"");
expect(prod.vars?.E2E_MODE === undefined, "prod に E2E_MODE がない");
expect(e2e.routes === undefined && e2e.route === undefined, "e2e の環境に routes がない");
// どの環境でも workers.dev とプレビューの URL を開けない（e2e を誤ってデプロイしても公開されないように）。prod 以外に routes を書かない
for (const [name, e] of Object.entries(c.env ?? {})) {
  expect(e.workers_dev !== true, `${name} の workers_dev を true にしない`);
  expect(e.preview_urls !== true, `${name} の preview_urls を true にしない`);
  if (name !== "prod") expect(e.routes === undefined && e.route === undefined, `${name} の環境に routes がない`);
}
expect(c.routes === undefined && c.route === undefined, "トップレベルに routes がない");

if (process.argv.includes("--deploy")) {
  for (const name of ["GOOGLE_CLIENT_ID", "VAPID_PUBLIC_KEY"]) {
    const v = prod.vars?.[name];
    expect(typeof v === "string" && v.trim() !== "", `prod の vars.${name} が空（転記していない）`);
  }
  const isZeroPlaceholder = (id) => typeof id !== "string" || /^[0-]*$/.test(id);
  for (const d of prod.d1_databases ?? []) {
    expect(!isZeroPlaceholder(d.database_id), `prod の D1（${d.binding}）の database_id がすべて0の仮の値（転記していない）`);
  }
  for (const k of prod.kv_namespaces ?? []) {
    expect(!isZeroPlaceholder(k.id), `prod の KV（${k.binding}）の id がすべて0の仮の値（転記していない）`);
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::wrangler.jsonc：${e}`);
  process.exit(1);
}
console.log("wrangler.jsonc の検査：問題なし");
