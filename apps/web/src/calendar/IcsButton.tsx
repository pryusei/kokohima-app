import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { redirectTo } from "../pages/CalendarSettingsPage";
import { useOnline } from "../ui/online";
import { createIcsLink } from "./queries";

// 成立した予定を端末のカレンダーに入れる（.ics。docs/specs/T-06-calendar.md 決定事項10）。
// 「カレンダーに追加」で開く選択肢の1行（MeetupCalendarActions。docs/specs/T-59-choose-calendar-add.md「振る舞い 1.」）

/**
 * .ics は一時的な URL を発行してから画面遷移する（iOS では OS のカレンダーへの追加が開く）。
 * 名前は端末で変える（deviceCalendar.ts）。オフラインの間・送っている間は押せない（T-11・T-56 M-14）
 */
export function IcsButton({ meetupId, label, className }: { meetupId: string; label: string; className: string }) {
  const online = useOnline();
  const [failed, setFailed] = useState<false | "failed" | "limited">(false);
  const ics = useMutation({
    mutationFn: () => createIcsLink(meetupId),
    onMutate: () => setFailed(false),
    onSuccess: (link) => {
      if (link) redirectTo.go(link.url);
    },
    // 回数の上限（429。T-10）は、少し待ってもらう
    onError: (error) => setFailed(error instanceof ApiError && error.status === 429 ? "limited" : "failed"),
  });
  return (
    <>
      <button
        type="button"
        className={`${className} disabled:text-ink-disabled ${ics.isPending ? "cursor-default opacity-70" : ""}`}
        disabled={!online}
        aria-disabled={ics.isPending || undefined}
        onClick={() => {
          if (!ics.isPending) ics.mutate();
        }}
      >
        {label}
      </button>
      {failed && (
        <p role="status" className="px-4 pb-3 text-s text-ink-muted">
          {failed === "limited" ? "少し待ってから、もう一度お試しください" : "カレンダーに追加できませんでした。もう一度お試しください"}
        </p>
      )}
    </>
  );
}
