// 本番のビルドの画面（apps/web/dist）を検査する（docs/specs/T-12-release.md「ビルドとデプロイのコマンド」）。
// CI と deploy:prod の前に走らせる。手元の .env.local などが本番のビルドに入り込んでも、ここで止まる
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTACT_NOTICE_MARKER,
  CONTACT_POLICY_MARKER,
  contactStartProblems,
  effectiveDateProblems,
  jstToday,
  revisionNoticeLine,
} from "./lib/effective-date.mjs";
import { findPublishedStrings, PRODUCTION_ORIGIN } from "./lib/published-notice.mjs";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
const errors = [];
// --deploy：deploy:prod のときだけ。制定日・改定日・公表日が決まっていない、または今日（日本時間）と合わなければ止める（docs/specs/T-19-privacy-terms.md「5.」）
const deploy = process.argv.includes("--deploy");

const index = join(dist, "index.html");
if (!existsSync(index)) {
  console.error(`::error::${index} がありません（apps/web をビルドしてください）`);
  process.exit(1);
}
const html = readFileSync(index, "utf8");
// インラインの script（src のない script）・style 要素・style 属性は CSP で止まるので、置かない
for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
  if (!/\bsrc\s*=/.test(m[1] ?? "")) errors.push("index.html にインラインの script があります");
}
if (/<style\b/i.test(html)) errors.push("index.html にインラインの style 要素があります");
if (/\sstyle\s*=/i.test(html)) errors.push("index.html に style 属性があります");

// ヘッダーと振り分けはコードだけで決める
for (const name of ["_headers", "_redirects"]) {
  if (existsSync(join(dist, name))) errors.push(`dist に ${name} があります`);
}

// E2E 用の名前と Apple のログインのボタンが入っていないこと
const forbidden = [
  /__e2e__/,
  /e2eLogin|e2eExpireBroadcast|e2eCalendar|e2eOutbox|e2eFetch|e2eNotification|e2eDeliverPending|e2eOgpFetch|E2E_LINK_PREVIEW|e2eContact|E2E_CONTACT/,
  /google\.e2e\.invalid|resend\.e2e\.invalid|push\.e2e\.invalid|ogp\.e2e\.invalid|slack\.e2e\.invalid/,
  /Appleでログイン/,
  // 文言が変わっても見つかるように、Apple のボタンには data-provider="apple-login" の目印を付けている
  /apple-login/,
];
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
for (const file of walk(dist)) {
  const text = readFileSync(file, "latin1");
  const utf8 = readFileSync(file, "utf8");
  for (const re of forbidden) {
    if (re.test(text) || re.test(utf8)) errors.push(`${file.slice(dist.length + 1)} に ${re} があります`);
  }
}

// 制定日・改定日・公表日の行：いつも「制定日：」がちょうど1回、改定日・公表日は1回まで（日付の大小は見ない）。
// --deploy では本物の日付であることと、デプロイする時刻の日本時間の日付との大小も（docs/specs/T-19-privacy-terms.md「5.」）
const scripts = walk(dist).filter((f) => f.endsWith(".js"));
// 予告の行があれば、本番にもう出ているかを本番の画面から読んで確かめる（まだなら、このデプロイの日が公表日）。読めなければ止める
const texts = scripts.map((f) => readFileSync(f, "utf8"));
const today = deploy ? jstToday(Date.now()) : undefined;
const notice = deploy ? revisionNoticeLine(texts) : null;
let noticeAlreadyPublished;
// 問い合わせ（T-24）の変更が本番に出ているか（予告の行と同じ1回の読み込みで確かめる）。読めなければ undefined（要るときに止める）
let production;
if (notice) {
  try {
    const found = await findPublishedStrings([notice, CONTACT_NOTICE_MARKER, CONTACT_POLICY_MARKER]);
    noticeAlreadyPublished = found.get(notice) === true;
    production = { notice: found.get(CONTACT_NOTICE_MARKER) === true, policy: found.get(CONTACT_POLICY_MARKER) === true };
  } catch (e) {
    errors.push(`本番（${PRODUCTION_ORIGIN}）の画面を読めなかったので、予告の行がもう出ているかを確かめられません（${e instanceof Error ? e.message : e}）`);
  }
}
errors.push(...effectiveDateProblems(texts, { deploy, today, noticeAlreadyPublished }));
// 問い合わせの公開の日は、改定日（効力が生じる日）と同じ日。予告の途中で問い合わせを足さない（docs/specs/T-24-contact.md「振る舞い 11.」）
const contactStartPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "shared", "src", "contactStart.json");
const { startDate } = JSON.parse(readFileSync(contactStartPath, "utf8"));
errors.push(...contactStartProblems(texts, { startDate, deploy, today, noticeAlreadyPublished, production }));

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log("apps/web/dist の検査：問題なし");
