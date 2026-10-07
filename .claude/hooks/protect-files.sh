#!/usr/bin/env bash
# PreToolUse: 秘密情報と適用済みマイグレーションへの書き込みを止める（要 jq）
path=$(jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0
case "$path" in
  *.dev.vars|*.dev.vars.*|*/.env|*/.env.*)
    echo "秘密情報のファイルは編集できません。wrangler secret を使ってください" >&2; exit 2 ;;
esac
if [[ "$path" == */migrations/* ]] && [ -f "$path" ]; then
  echo "適用済みのマイグレーションは編集できません。新しいファイルを作ってください" >&2; exit 2
fi
exit 0
