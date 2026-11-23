# アイコンの画像の運用（T-27）

docs/specs/T-27-avatar-upload.md の「文書（実装PRで直すもの）」の手順書。

## 署名の鍵 `AVATAR_URL_KEY` を入れる（デプロイの前に、環境ごとに1回）

1. 32バイトのランダム値を作る：

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. `pnpm --filter api exec wrangler secret put AVATAR_URL_KEY --env <staging|prod>` で入れる。値はどこにも書き残さない。
3. 鍵を変えるときも同じ手順。出していた URL は、次に画面がプロフィールを取り直すまで404になり、表示名の1文字めに戻るだけ（鍵の版は持たない）。

ローカルは `apps/api/.dev.vars` に `AVATAR_URL_KEY=<値>`（`dev-vars.example`）。E2E は `scripts/write-e2e-dev-vars.mjs` が作る。

## R2 のバケット

- `kokohima-<env>-avatars`（`infra/terraform/modules/kokohima/main.tf` の `cloudflare_r2_bucket.avatars`）。`terraform apply` は人が行う。
- 中身は `avatars/v1/<avatar_id>`。R2 の物と台帳（`avatar_images`）を、手で直接は消さない（画像を消す道は毎分の掃除の1つだけ）。

## 削除の求めへの手での対応（利用規約の第5条4）

1. `ops@kokohima.app` か問い合わせで、どの人のアイコンかを確かめる。求めた人に、画像の URL や画面の写しを送ってもらってよい（URL の `/api/v1/avatars/<avatar_id>` の部分で特定できる）。
2. 内容を確かめ、消すと判断したら、本番の D1 でその人のアイコンを外す：

   ```bash
   pnpm --filter api exec wrangler d1 execute kokohima-prod --remote --env prod --command "UPDATE users SET avatar_id = NULL, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE avatar_id = '<avatar_id>'"
   ```

3. 1時間ほどで掃除が R2 と台帳から消す。消えたことは `avatar_images` に `<avatar_id>` の行がないことで確かめる。
4. 本人がまた同じ画像を置くことは止めない（止める仕組みは持たない。くり返すときは利用規約の第7条で対応を決める）。

## 監視

- `avatar_cleanup_failed`（R2 の削除の失敗）が続くときは、R2 の状態を確かめる。台帳の行は残るので、直れば次の回で消える。
