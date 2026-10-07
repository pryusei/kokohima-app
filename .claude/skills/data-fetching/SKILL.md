---
name: data-fetching
description: フロントエンド（apps/web）でのデータ取得と更新の方針。TanStack Query、APIクライアント、キャッシュ、楽観的更新、テスト
---
# データ取得（TanStack Query）

## 基本
- サーバーのデータはTanStack Queryで扱う。サーバーのデータをグローバルストアやuseStateに複製しない
- 画面だけの状態（開いているシート、入力中の値）はuseStateで持つ
- クエリキーは `apps/web/src/api/keys.ts` のキー工場で一元管理する（例：`keys.invites.received()`）。文字列を画面ごとに直書きしない

## APIクライアント
- `apps/web/src/api/client.ts` の1つのラッパーを通す。アクセストークン（メモリ保持）をヘッダーに付ける
- 401が返ったら、更新用トークン（Cookie）で1回だけ取り直して再送する。失敗したらログアウト状態にする
- レスポンスは `packages/shared` のZodスキーマで検証してから使う

## 楽観的更新
- 「押したらすぐ反映して見せたい」操作は楽観的更新にする：返答（行く／今回は難しい／この時間なら）、ここ暇の追加・取り消し、公開設定の切り替え
- 手順：onMutateでキャッシュを退避して先に更新 → onErrorで元に戻す → onSettledで関係するクエリを無効化して取り直す
- IMPORTANT: 募集の「決める」では、応じた人の名前をクライアント側で推測・先出ししない。名前はサーバーの応答で受け取ってから表示する
- 失敗時の表示は静かに行う。断りや期限切れと同じく、赤やエラー色で驚かせない

## 取得の仕方
- 独立したデータは並列に取る（useQueries、または画面の入り口でprefetch）。取得の連鎖（ウォーターフォール）を作らない
- 受信した誘いはウィンドウに戻ったときに取り直す（refetchOnWindowFocus）。細かい即時性は通知に任せ、短い間隔のポーリングはしない
- クエリのキャッシュをlocalStorageなどに永続化しない（個人情報を含むため）

## テスト
- テストごとに新しいQueryClientを作り、`retry: false` にする
- fetchはモックし、楽観的更新は「成功時」「失敗時に元に戻る」の両方を単体テストで確かめる

## vercel-react-best-practices との関係
- `client-swr-dedup`（SWRで重複排除）は、TanStack Queryの同じキーによる重複排除で読み替える。SWRは導入しない
