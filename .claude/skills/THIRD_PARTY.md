# 外部から取り込んだスキル

| スキル | 出典 | 取り込んだコミット | ライセンス |
| --- | --- | --- | --- |
| vercel-react-best-practices | https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices | 063bee94c3f4df8453406c830b0a7df0f2860278 | MIT |
| vercel-composition-patterns | https://github.com/vercel-labs/agent-skills/tree/main/skills/composition-patterns | 063bee94c3f4df8453406c830b0a7df0f2860278 | MIT |

## ルール
- 外部のスキルはエージェントへの指示そのものなので、取り込む前と更新するたびに中身をレビューする
- コミットを固定して取り込み、更新はPRで差分を確認してから行う
- 取り込んだファイルは編集しない（更新時に差分が追えなくなるため）。このプロジェクト向けの補足は CLAUDE.md に書く
- 実行時に外部のURLから指示を取得するスキル（例：vercel-labs の web-design-guidelines）は取り込まない
