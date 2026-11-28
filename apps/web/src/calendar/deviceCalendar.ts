// 端末のカレンダーに入れるボタン（.ics）の名前（docs/specs/T-59-choose-calendar-add.md「振る舞い 1.」決めたこと4）。
// 画面に「.ics」と書かず、押すと何が起きるかを端末の名前で伝える。判定を外しても、押したときの動きは同じ（名前が違うだけ）

/** iPadOS の Safari は Mac と名乗るので、タッチ点の数で見分ける */
export function deviceCalendarLabel(userAgent: string, maxTouchPoints: number): string {
  if (/iPhone|iPod/.test(userAgent)) return "iPhoneのカレンダーに追加";
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return "iPadのカレンダーに追加";
  if (/Macintosh/.test(userAgent)) return "Macのカレンダーに追加";
  return "ほかのカレンダーに追加";
}

/** この端末での名前（画面を開いたときに1回だけ読む） */
export const currentDeviceCalendarLabel = () => deviceCalendarLabel(navigator.userAgent, navigator.maxTouchPoints);
