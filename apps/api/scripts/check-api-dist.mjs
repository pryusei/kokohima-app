// 本番のビルドの API（apps/api/dist）に、E2E 用の経路と部品が入っていないことを確かめる（docs/specs/T-01-auth.md、T-12）。
// CI の build:prod のあとと、deploy:prod の本番へのデプロイの直前に走らせる
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (!existsSync(dist)) {
  console.error("::error::apps/api/dist がありません（wrangler deploy --dry-run --outdir dist を先に）");
  process.exit(1);
}
// 経路の文字列だけでなく、テスト用ログインの関数名・偽の宛先も確かめる
const forbidden =
  /__e2e__|e2eLogin|e2eExpireBroadcast|e2eCalendar|e2eOutbox|e2eFetch|e2eNotification|e2eDeliverPending|google\.e2e\.invalid|resend\.e2e\.invalid|push\.e2e\.invalid|ogp\.e2e\.invalid|e2eOgpFetch|E2E_LINK_PREVIEW|e2eContact|E2E_CONTACT|slack\.e2e\.invalid|e2eClaude|claudeStreamBody/;
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const hits = walk(dist).filter((f) => forbidden.test(readFileSync(f, "utf8")));
if (hits.length > 0) {
  for (const f of hits) console.error(`::error::本番のビルドに E2E 用の経路が含まれています：${f.slice(dist.length + 1)}`);
  process.exit(1);
}
console.log("apps/api/dist の検査：問題なし");
