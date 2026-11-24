import type { Meetup } from "@kokohima/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { meQuery, nameOfProfile } from "../account/me";
import { avatarInitial, useAvatarImage } from "../ui/Avatar";
import { formatRange } from "./format";
import { hasSeenMeetMoment, markMeetMomentSeen } from "./meetMomentSeen";
import { meetupQuery } from "./queries";

// 成立の演出「ふたつの灯りが重なる」（docs/specs/T-43-meet-moment.md）。
// 灯り（lamp）の色の丸が寄って重なり、成立の青緑（meet）に変わる。動きは CSS だけ（index.css の kh-meet-*）で、
// prefers-reduced-motion では index.css の共通の決まりで止まり、重なった丸の一枚絵になる。
// 丸の中はアイコンの画像（なければ・読めるまでは1文字め）。色の意味は、画像のまわりの3pxの輪（丸の地の色）で運ぶ（docs/specs/T-58-meet-moment-avatars.md）

/** 並べる丸の数の上限（自分を含む）。ほかの参加者が多いときは、最後の丸を「+n」にする */
export const MEET_MOMENT_MAX_DOTS = 4;

/** 丸1つ。src はアイコンの画像の URL（API の avatarUrl そのまま。退会した人と「+n」は null） */
export type MeetMomentDot = { key: string; label: string; src: string | null };

type Self = { displayName: string | null; avatarUrl: string | null };

/** 丸の並び：自分を左に、ほかの参加者は予定の参加者の順。5人以上は「自分・2人・+n」 */
export function meetMomentDots(me: Self | null, others: Meetup["participants"]): MeetMomentDot[] {
  const self: MeetMomentDot = { key: "me", label: avatarInitial(me?.displayName ?? null), src: me?.avatarUrl ?? null };
  const people = others.map((p) =>
    p.withdrawn ? { key: p.id, label: "？", src: null } : { key: p.id, label: avatarInitial(p.displayName), src: p.avatarUrl },
  );
  if (people.length + 1 <= MEET_MOMENT_MAX_DOTS) return [self, ...people];
  const shown = people.slice(0, MEET_MOMENT_MAX_DOTS - 2);
  return [self, ...shown, { key: "more", label: `+${people.length - shown.length}`, src: null }];
}

/** 「〇〇と会える」の名前の部分。3人以上は「a・bほかn人」 */
export function meetMomentWith(others: Meetup["participants"]): string {
  const names = others.map(nameOfProfile);
  if (names.length <= 2) return names.join("・");
  return `${names.slice(0, 2).join("・")}ほか${names.length - 2}人`;
}

/** 丸が寄ってくる前の横のずれ（px）。真ん中から外へ。2つのときは大きく、増えるほど小さく（画面の幅に収める） */
export function meetMomentOffset(index: number, count: number): number {
  const step = count <= 2 ? 148 : count === 3 ? 64 : 40;
  return Math.round((index - (count - 1) / 2) * step);
}

/**
 * この画面で成立の演出を流すか。予定の ID ごとに、最初に描いたときに一度だけ決める（描画の中で前の値と比べる）。
 * 流すのは、この端末でまだ見ていない、閲覧者から見て成立中（confirmed）で、まだ終わっていない予定だけ。
 * 端末に「見た」と記録するのは、予定を参加者として読めて、流すと決まったときだけ（読めない・404・取り消し・終わった予定は記録しない）。
 * 記録したあとも、その画面を開いている間は出し続ける（同じ予定では、ほかの画面でも二度と流さない）
 */
export function useMeetMoment(meetupId: string | null): Meetup | null {
  const [decision, setDecision] = useState<{ id: string; first: boolean } | null>(null);
  if (meetupId !== null && decision?.id !== meetupId) {
    setDecision({ id: meetupId, first: !hasSeenMeetMoment(meetupId) });
  }
  const first = meetupId !== null && decision?.id === meetupId && decision.first;
  // 表示した時点の時刻で判定する（描画のたびに時計を読まない）
  const [openedAt] = useState(() => Date.now());
  const meetup = useQuery({ ...meetupQuery(meetupId ?? ""), enabled: first });
  const m = meetup.data;
  const result =
    first && m && m.id === meetupId && m.status === "confirmed" && Date.parse(m.endsAt) > openedAt ? m : null;
  const playingId = result?.id ?? null;
  useEffect(() => {
    if (playingId !== null) markMeetMomentSeen(playingId);
  }, [playingId]);
  return result;
}

/** 成立の演出と「決まった！」。children に、その画面にまだない成立後の操作を置く */
export function MeetMoment({ meetup, children }: { meetup: Meetup; children?: ReactNode }) {
  const me = useQuery(meQuery());
  const dots = meetMomentDots(me.data ?? null, meetup.participants);
  const reveal = (i: number) => ({ "--kh-meet-i": i }) as CSSProperties;
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="-mx-6 flex flex-col items-center gap-2 bg-meet-soft px-6 pt-4 pb-6 text-center"
    >
      <div aria-hidden="true" className="kh-meet-pair flex h-24 items-center justify-center">
        {dots.map((dot, i) => (
          <MeetDot key={dot.key} dot={dot} index={i} count={dots.length} />
        ))}
      </div>
      <h3 id={titleId} className="kh-meet-reveal text-xxl font-bold" style={reveal(0)}>
        決まった！
      </h3>
      <p className="kh-meet-reveal font-bold tabular-nums" style={reveal(1)}>
        {formatRange(meetup)}
      </p>
      {meetup.area && (
        <p className="kh-meet-reveal font-bold text-meet-ink" style={reveal(2)}>
          エリア：{meetup.area}
        </p>
      )}
      {meetup.participants.length > 0 && (
        <p className="kh-meet-reveal text-ink-muted" style={reveal(3)}>
          {meetMomentWith(meetup.participants)}と会える
        </p>
      )}
      {children && (
        <div className="kh-meet-reveal mt-2 flex w-full flex-col gap-2" style={reveal(4)}>
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * 丸1つ。外径72px（size-18）・meet-soft の3pxの縁・その内側の3pxが色の輪（丸の地の色。灯り→成立）・中身60px（size-15）。
 * 画像は待たずに1文字めを出し、読めた時点（load）で動きなしで差し替える。画像の大きさはクラスで決め、読み込みに頼らない
 */
function MeetDot({ dot, index, count }: { dot: MeetMomentDot; index: number; count: number }) {
  const { showImage, onError } = useAvatarImage(dot.src);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const loaded = showImage && loadedSrc === dot.src;
  return (
    <span
      data-testid="meet-dot"
      style={{ "--kh-meet-from": `${meetMomentOffset(index, count)}px`, zIndex: count - index } as CSSProperties}
      className={`kh-meet-dot relative grid size-18 shrink-0 place-items-center rounded-full border-3 border-meet-soft bg-meet text-xl font-bold text-on-meet ${index > 0 ? "-ml-5" : ""}`}
    >
      {!loaded && dot.label}
      {showImage && (
        <img
          src={dot.src ?? undefined}
          alt=""
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          className={`absolute inset-[3px] size-15 rounded-full object-cover ${loaded ? "" : "invisible"}`}
          onLoad={() => setLoadedSrc(dot.src)}
          onError={onError}
        />
      )}
    </span>
  );
}
