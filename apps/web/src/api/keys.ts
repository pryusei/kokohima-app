// クエリキーの工場（data-fetching スキル）。画面ごとに文字列を直書きしない
export const keys = {
  me: () => ["me"] as const,
  friends: {
    all: () => ["friends"] as const,
    list: () => ["friends", "list"] as const,
  },
  inviteLinks: {
    list: () => ["invite-links", "list"] as const,
  },
};
