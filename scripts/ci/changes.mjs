// PR の変更の分類（docs/specs/T-30-ci-review.md「1. 変更の分類」）。
// CI の ci（changes・require-unit-tests）と e2e（prepare）から呼ぶ。依存のパッケージを使わない（pnpm install の前に動かす）
//
//   node scripts/ci/changes.mjs <比べる先>                       分類を出す（GITHUB_OUTPUT があれば docs_only を書く）
//   node scripts/ci/changes.mjs <比べる先> --require-unit-tests  実装PRに単体テストがなければ落とす
// 比べる先は PR の宛先ではなく既定のブランチ（origin/main）。チェックの結果は PR ではなくコミットに付くので、宛先で結果が変わると、
// 同じコミットで宛先を main 以外にした PR を作るだけで、必須チェックを飛ばせてしまうため
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 文書だけを入れるところの外にあるコード・テストの置き場所。ここの下の .md は文書に数えない（テストやビルドで読むかもしれないため） */
const CODE_ROOT = /^(apps|packages|e2e|scripts)\//;

/**
 * `git diff --name-status -z -M` の出力を読む。NUL で区切った「状態、パス」の並びで、名前の変更（R）と複写（C）はパスが2つ（移動元と移動先）続く。
 * -z で読むのは、日本語や `"` を含むパスを git が引用符で囲んでエスケープし、置き場所の判定に合わなくなるのを防ぐため
 */
export function parseNameStatus(text) {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++] ?? "";
    const status = code.charAt(0);
    const count = status === "R" || status === "C" ? 2 : 1;
    const paths = fields.slice(i, i + count);
    i += count;
    if (!/^[A-Z]\d*$/.test(code) || paths.length !== count || paths.some((p) => p === "")) {
      throw new Error(`git diff の出力を読めません：${JSON.stringify(code)}`);
    }
    changes.push({ status, path: paths[paths.length - 1], paths });
  }
  return changes;
}

/** 文書：docs/ の下か、コードの置き場所の外にある .md */
export const isDoc = (path) => path.startsWith("docs/") || (path.endsWith(".md") && !CODE_ROOT.test(path));

/** 単体テスト：apps/・packages/・scripts/ の下の *.test.ts(x) と、e2e/ の下の *.unit.ts（Playwright の設定のテスト） */
export const isUnitTest = (path) => /^(apps|packages|scripts)\/.+\.test\.tsx?$/.test(path) || /^e2e\/.+\.unit\.ts$/.test(path);

/** 単体テストを求めるコード：apps/・packages/・scripts/ の下で、.md と package.json でないもの */
export const isCode = (path) =>
  /^(apps|packages|scripts)\//.test(path) && !path.endsWith(".md") && !/(^|\/)package\.json$/.test(path);

/**
 * 変更を分類する。
 * - docsOnly：変更がすべて文書（名前の変更は、移動元と移動先の両方が文書のとき）。変更がないときは false（念のため回す）
 * - needsUnitTest：消した（D）のでないコードがある。名前の変更は移動先で判定する
 * - hasUnitTest：消した（D）のでない単体テストがある
 */
export function classify(changes) {
  const kept = changes.filter((c) => c.status !== "D");
  return {
    docsOnly: changes.length > 0 && changes.every((c) => c.paths.every(isDoc)),
    needsUnitTest: kept.some((c) => isCode(c.path)),
    hasUnitTest: kept.some((c) => isUnitTest(c.path)),
  };
}

function main(argv) {
  const [base, ...flags] = argv;
  if (!base || base.startsWith("-")) {
    console.error("::error::比べる先（例：origin/main）を渡してください");
    return 2;
  }
  const diff = execFileSync("git", ["diff", "--name-status", "-z", "-M", `${base}...HEAD`], { encoding: "utf8" });
  const changes = parseNameStatus(diff);
  const result = classify(changes);
  console.log(`変更：${changes.length} 件 / 文書だけ：${result.docsOnly} / コード：${result.needsUnitTest} / 単体テスト：${result.hasUnitTest}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${result.docsOnly}\n`);
  if (flags.includes("--require-unit-tests") && result.needsUnitTest && !result.hasUnitTest) {
    console.error("::error::実装PRには単体テスト（*.test.ts）の追加・変更が必要です");
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
