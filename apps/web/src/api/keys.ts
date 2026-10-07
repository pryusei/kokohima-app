// クエリキーの工場（data-fetching スキル）。画面ごとに文字列を直書きしない
export const keys = {
  me: () => ["me"] as const,
};
