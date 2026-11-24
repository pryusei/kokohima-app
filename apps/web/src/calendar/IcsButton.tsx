import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { redirectTo } from "../pages/CalendarSettingsPage";
import { SendButton } from "../ui/Button";
import { createIcsLink } from "./queries";

// 成立した予定を .ics でカレンダーに追加する（docs/specs/T-06-calendar.md 決定事項10）。
// 成立した予定の詳細と、成立の演出のあと（docs/specs/T-43-meet-moment.md「4.」）で使う

/** .ics は一時的な URL を発行してから画面遷移する（iOS では OS のカレンダーへの追加が開く） */
export function IcsButton({ meetupId }: { meetupId: string }) {
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
      <SendButton block onClick={() => ics.mutate()}>
        カレンダーに追加（.ics）
      </SendButton>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          {failed === "limited" ? "少し待ってから、もう一度お試しください" : "カレンダーに追加できませんでした。もう一度お試しください"}
        </p>
      )}
    </>
  );
}
