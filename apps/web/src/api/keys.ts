// クエリキーの工場（data-fetching スキル）。画面ごとに文字列を直書きしない
export const keys = {
  me: () => ["me"] as const,
  friends: {
    all: () => ["friends"] as const,
    list: () => ["friends", "list"] as const,
    detail: (id: string) => ["friends", "detail", id] as const,
  },
  // ここ暇。自分の枠が変わると「みんな」の重なりの印も変わるので、まとめて無効にできるよう all の下に置く
  availability: {
    all: () => ["availability"] as const,
    mine: (from: string) => ["availability", "mine", from] as const,
    rules: () => ["availability", "rules"] as const,
    presets: () => ["availability", "presets"] as const,
    everyone: (from: string) => ["availability", "everyone", from] as const,
    friend: (id: string, from: string) => ["availability", "friend", id, from] as const,
  },
  // 誘いと成立した予定。返答で両方が変わるので、まとめて無効にできるよう all を持つ
  invites: {
    all: () => ["invites"] as const,
    list: (box: "received" | "sent") => ["invites", "list", box] as const,
    detail: (id: string) => ["invites", "detail", id] as const,
  },
  meetups: {
    all: () => ["meetups"] as const,
    list: () => ["meetups", "list"] as const,
    detail: (id: string) => ["meetups", "detail", id] as const,
  },
  inviteLinks: {
    list: () => ["invite-links", "list"] as const,
  },
};
