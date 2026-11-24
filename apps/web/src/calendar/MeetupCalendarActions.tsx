import { calendarAuthorizationSchema, type CalendarConnectionStatus, type Meetup } from "@kokohima/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { redirectTo } from "../pages/CalendarSettingsPage";
import { SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Link } from "../ui/Link";
import { IcsButton } from "./IcsButton";
import { connectionsQuery } from "./queries";

// 成立した予定のカレンダーへの入れ方の欄（docs/specs/T-57-meetup-google-calendar.md「振る舞い」）。
// 閲覧者自身の Google カレンダーの連携の状態に応じた1行かボタンと、その下に .ics。
// 成立した予定の詳細と、成立の演出の中（誘いの詳細・募集の詳細。T-43）で使う

/** 連携を始める。meetupId は戻り先（この予定の画面）だけに使う */
const startConnect = (meetupId: string) =>
  apiSend("POST", "/api/v1/calendar/google/authorizations", { meetupId }, calendarAuthorizationSchema);

export function MeetupCalendarActions({ meetup }: { meetup: Meetup }) {
  // 画面を開いた時刻で1回だけ判定する（描画のたびに時計を読まない）
  const [openedAt] = useState(() => Date.now());
  // Google に入れる対象（成立中で、まだ終わっていない予定）だけ、連携の状態を読む
  const writable = meetup.status === "confirmed" && Date.parse(meetup.endsAt) > openedAt;
  const connections = useQuery({ ...connectionsQuery(), enabled: writable });
  // 読んでいる間・読めなかったときは Google の行を出さない（.ics だけの画面と同じにする）
  const status = writable ? connections.data?.google.status : undefined;
  return (
    <>
      {status && <GoogleRow meetupId={meetup.id} status={status} />}
      <IcsButton meetupId={meetup.id} label={status ? "ほかのカレンダーに追加（.ics）" : undefined} />
    </>
  );
}

function GoogleRow({ meetupId, status }: { meetupId: string; status: CalendarConnectionStatus }) {
  const [failed, setFailed] = useState<false | "failed" | "limited">(false);
  const connect = useMutation({
    mutationFn: () => startConnect(meetupId),
    onMutate: () => setFailed(false),
    onSuccess: (data) => {
      if (data) redirectTo.go(data.authorizeUrl);
    },
    // 回数の上限（429）は、少し待ってもらう
    onError: (error) => setFailed(error instanceof ApiError && error.status === 429 ? "limited" : "failed"),
  });

  // 書けたかどうかは画面で知れないので、「入っています」とは言わず、印も付けない（T-57 決めたこと1）
  if (status === "connected") return <Note>連携中なので、Googleカレンダーの『ここ暇』に自動で入ります</Note>;
  if (status === "needs_reauth") {
    return (
      <p className="text-s text-ink-muted">
        Googleカレンダーに入れるには、もう一度連携してください。<Link to="/settings/calendar" className="text-action underline">
          カレンダー連携へ
        </Link>
      </p>
    );
  }
  return (
    <>
      <SendButton variant="primary" block pending={connect.isPending} onClick={() => connect.mutate()}>
        Googleカレンダーに自動で入れる
      </SendButton>
      <Note>連携すると、これからの予定もまとめて入ります。読むのは空き／埋まりだけです</Note>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          {failed === "limited" ? "少し待ってから、もう一度お試しください" : "連携を始められませんでした。もう一度お試しください"}
        </p>
      )}
    </>
  );
}
