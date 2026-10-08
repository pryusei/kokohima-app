import { meetupSchema, type Meetup } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { Nav } from "../components/Nav";
import { formatRange, linkLabel } from "../invitations/format";
import { meetupQuery } from "../invitations/queries";
import { displayNameOf } from "./FriendsPage";

// 成立した予定（仮。docs/specs/T-04-direct-invite.md「画面」）。「やっぱり難しい」は確認なしで送る

export function MeetupDetailPage({ meetupId }: { meetupId: string }) {
  const queryClient = useQueryClient();
  const meetup = useQuery(meetupQuery(meetupId));
  const [failed, setFailed] = useState(false);
  // 表示した時点の時刻で判定する（描画のたびに時計を読まない）
  const [openedAt] = useState(() => Date.now());
  const key = keys.meetups.detail(meetupId);

  const cancel = useMutation({
    mutationFn: () => apiSend("POST", `/api/v1/meetups/${meetupId}/cancel`, undefined, meetupSchema),
    onMutate: async () => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Meetup>(key);
      queryClient.setQueryData<Meetup>(key, (m) => m && { ...m, status: "cancelled" });
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      setFailed(true);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.meetups.all() });
      await queryClient.invalidateQueries({ queryKey: keys.invites.all() });
    },
  });

  if (meetup.error instanceof ApiError && meetup.error.status === 404) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <Nav />
        <p className="text-slate-600">この予定は見つかりませんでした。</p>
      </main>
    );
  }
  const m = meetup.data;
  const host = m ? linkLabel(m.url) : null;
  // 開始後はキャンセルできないので、ボタンを出さない（決定事項4）
  const cancellable = m?.status === "confirmed" && Date.parse(m.startsAt) > openedAt;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">成立した予定</h1>
      <Nav />
      {m && (
        <section className="flex flex-col gap-2">
          <p className="font-bold">{m.participants.map((p) => displayNameOf(p.displayName)).join("・")}</p>
          <p>{formatRange(m)}</p>
          {m.area && <p>エリア：{m.area}</p>}
          {m.message && <p className="whitespace-pre-wrap">{m.message}</p>}
          {m.url && host && (
            <a href={m.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
              {host}
            </a>
          )}
          {m.status === "cancelled" ? (
            <p className="text-slate-600">やっぱり難しくなりました</p>
          ) : (
            <p className="text-emerald-800">成立</p>
          )}
          {cancellable && (
            <button type="button" className="self-start rounded-lg border px-4 py-2" onClick={() => cancel.mutate()}>
              やっぱり難しい
            </button>
          )}
          {failed && (
            <p role="status" className="text-sm text-slate-600">
              送れませんでした。もう一度お試しください
            </p>
          )}
        </section>
      )}
    </main>
  );
}
