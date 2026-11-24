// 成立の演出を「見た」予定の記録（docs/specs/T-43-meet-moment.md「2.」）。
// サーバーには保存せず、この端末の localStorage に予定の ID だけを置く（名前・時間・中身は置かない）。
// 読めない・書けない（プライベートブラウズ、容量、無効）ときは「見ていない」として扱い、画面を落とさない

export const MEET_MOMENT_SEEN_KEY = "kokohima.meetMomentSeen";
/** 覚えておく件数。古いものから捨てる */
export const MEET_MOMENT_SEEN_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(MEET_MOMENT_SEEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && UUID.test(v)) : [];
  } catch {
    return [];
  }
}

export function hasSeenMeetMoment(meetupId: string): boolean {
  return read().includes(meetupId);
}

export function markMeetMomentSeen(meetupId: string) {
  if (!UUID.test(meetupId)) return;
  const next = [...read().filter((id) => id !== meetupId), meetupId].slice(-MEET_MOMENT_SEEN_MAX);
  try {
    window.localStorage.setItem(MEET_MOMENT_SEEN_KEY, JSON.stringify(next));
  } catch {
    // 書けなければ、次に開いたときもう一度流れるだけ
  }
}

/** ログアウト・退会で消す（同じ端末の次の人に、前の人の記録を残さない） */
export function clearMeetMomentSeen() {
  try {
    window.localStorage.removeItem(MEET_MOMENT_SEEN_KEY);
  } catch {
    // 消せなくても、残るのは予定の ID だけ
  }
}
