# ここ暇 開発キット

友達を誘う気まずさをなくすPWA「ここ暇」の、実装を始めるためのセットです。
リポジトリの直下に展開して使います。

## 中身

| パス | 内容 |
| --- | --- |
| `CLAUDE.md` | 実装LLMが毎回読むルール（短く保つ） |
| `.claude/skills/` | 必要なときだけ読み込むドメイン知識と手順 |
| `.claude/agents/` | 仕様レビュー・セキュリティレビューのサブエージェント |
| `.claude/hooks/` | 例外なく守らせるルール（秘密情報・適用済みマイグレーションの編集禁止） |
| `.claude/claude-security-guidance.md` | security-guidanceプラグインに渡す脅威モデル |
| `.claude/security-patterns.json` | 編集ごとに走る独自の検出パターン |
| `docs/requirements.md` | 要求定義書（仕様の正） |
| `docs/roadmap.md` | 今後の流れ、役割分担、実装順 |
| `docs/design/` | 画面一覧、Claude Design用プロンプト、モックへのリンク |
| `docs/tasks/` | タスク票のひな形と、最初のタスク（認証） |

## 使い始める手順

1. 展開して `git init` する（security-guidanceプラグインはgitリポジトリが前提）
2. Claude Codeで `/plugin install security-guidance@claude-plugins-official` を実行
3. スキャフォールド後に `/init` を実行し、`CLAUDE.md` のコマンドを実際の値に更新する
4. `jq` と Python 3.8以上を入れておく（フックとプラグインが使う）
5. `/implement-task docs/tasks/T-01-auth.md` で最初のタスクを始める

## 運用のルール

- 仕様が変わったら、先に `docs/requirements.md` を更新してから実装を頼む
- 認証・認可・暗号・外部連携のコードは、必ず人がレビューする
