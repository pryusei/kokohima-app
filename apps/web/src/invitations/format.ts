import type { DirectInvite, InviteKind } from "@kokohima/shared";
import { linkHostname } from "@kokohima/shared";
import { formatDate, formatSlot, localDateOf } from "../availability/format";

// 誘いの表示（docs/specs/T-04-direct-invite.md「画面」）。断り・期限切れ・見送り・キャンセルは静かな灰色で、理由は出さない

const QUARTER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_LENGTH_MS = 30 * 60 * 1000;

export const KIND_LABELS: Record<InviteKind, string> = { asobo: "あそぼ", kokodou: "ここどう？" };

/** 「10/10（土） 19:00〜23:00」 */
export function formatRange(range: { startsAt: string; endsAt: string }) {
  return `${formatDate(localDateOf(range.startsAt))} ${formatSlot({ ...range, label: null })}`;
}

/** 閲覧者から見た状態の文言 */
export function statusText(invite: Pick<DirectInvite, "status" | "direction" | "counterProposal">) {
  const sent = invite.direction === "sent";
  switch (invite.status) {
    case "pending":
      return sent ? "返事待ち" : "返事をしてください";
    case "counter_proposed":
      return sent && invite.counterProposal
        ? `この時間なら：${formatRange(invite.counterProposal)}`
        : "この時間ならと返しました";
    case "confirmed":
      return "成立";
    case "declined":
      return sent ? "今回は難しいみたい" : "今回は難しいと返しました";
    case "expired":
      return "期限が過ぎました";
    case "skipped":
      return sent ? "見送りました" : "見送りになりました";
    case "cancelled":
      return "やっぱり難しくなりました";
  }
}

/** 成立だけ色をつける（成立の色）。ほかはどれも同じ静かな灰色 */
export const statusClass = (status: DirectInvite["status"]) =>
  status === "confirmed" ? "text-emerald-800" : "text-slate-600";

/** リンクの表示用のドメイン（punycode）。解釈できなければ何も出さない */
export const linkLabel = (url: string | null) => (url ? linkHostname(url) : null);

/** 現在より後の、次の15分の区切り */
export const nextQuarter = (now: number) => Math.floor(now / QUARTER_MS) * QUARTER_MS + QUARTER_MS;

/**
 * 「みんな」の枠から誘うときの初期値。開始は次の15分の区切りと枠の開始の遅いほう、
 * 終了は枠の終了と開始から24時間の早いほう（「今から暇」の枠や24時間を超える枠でも、そのまま送れる時間にする）。
 * 調整した時間が30分未満になる（終わりかけの）枠は、送れる時間を作れないので null（「この時間に誘う」を出さない）
 */
export function initialRange(slot: { startsAt: string; endsAt: string }, now: number) {
  const startsAt = Math.max(nextQuarter(now), Date.parse(slot.startsAt));
  const endsAt = Math.min(Date.parse(slot.endsAt), startsAt + DAY_MS);
  if (endsAt - startsAt < MIN_LENGTH_MS) return null;
  return { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() };
}
