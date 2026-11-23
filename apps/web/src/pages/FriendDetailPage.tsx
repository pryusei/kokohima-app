import { friendSchema, type Friend } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { formatDate, formatSlot, localDateOf } from "../availability/format";
import { friendSlotsQuery, today } from "../availability/queries";
import { navigate } from "../router";
import { AvailabilityChip } from "../ui/AvailabilityChip";
import { Avatar } from "../ui/Avatar";
import { SheetScreen } from "../ui/BottomSheet";
import { Button, ButtonLink, SendButton } from "../ui/Button";
import { LoadError, Loading, Note } from "../ui/feedback";
import { Section } from "../ui/Navigation";
import { Switch } from "../ui/Switch";
import { displayNameOf } from "../account/me";
import { FriendWishList } from "../wish/FriendWishes";

// 友達の詳細（docs/specs/T-03-availability.md「画面」、キャンバス「16 友達の詳細」）
// 後ろに友達タブを出したシートで開く（docs/specs/T-11-design.md「画面のつながり」）

function Settings({ friend }: { friend: Friend }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = displayNameOf(friend.displayName);

  // 「自分の暇を見せる」は楽観的更新（data-fetching スキル）
  const toggle = useMutation({
    mutationFn: (sharesMyAvailability: boolean) =>
      apiSend("PATCH", `/api/v1/friends/${friend.id}`, { sharesMyAvailability }),
    onMutate: async (sharesMyAvailability) => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: keys.friends.detail(friend.id) });
      const previous = queryClient.getQueryData<Friend>(keys.friends.detail(friend.id));
      queryClient.setQueryData<Friend>(keys.friends.detail(friend.id), (f) => f && { ...f, sharesMyAvailability });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(keys.friends.detail(friend.id), context.previous);
      setFailed(true);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.friends.all() }),
  });

  const unfriend = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/v1/friends/${friend.id}`, undefined),
    onSuccess: () => {
      // 先に友達タブへ移る。解除した友達の詳細を読み直すと404になり、再試行を待つことになるので、その行は捨てる
      navigate("/friends", { replace: true });
      queryClient.removeQueries({ queryKey: keys.friends.detail(friend.id) });
      void queryClient.invalidateQueries({ queryKey: keys.friends.all() });
      void queryClient.invalidateQueries({ queryKey: keys.availability.all() });
      // 解除した友達の行きたいが「みんな」に残らないように（T-22）
      void queryClient.invalidateQueries({ queryKey: keys.wishes.all() });
    },
    onError: () => setFailed(true),
  });

  return (
    <div className="flex flex-col gap-4">
      <Switch checked={friend.sharesMyAvailability} onChange={(v) => toggle.mutate(v)} description="オフにしても、相手には通知されません">
        自分の暇を見せる
      </Switch>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        {confirming ? (
          <>
            <Note>解除しても相手には通知されません。</Note>
            <SendButton block onClick={() => unfriend.mutate()}>
              {name}さんとの友達を解除する
            </SendButton>
            <Button variant="ghost" block onClick={() => setConfirming(false)}>
              やめる
            </Button>
          </>
        ) : (
          <Button variant="ghost" block onClick={() => setConfirming(true)}>
            友達を解除
          </Button>
        )}
      </div>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          保存できませんでした。もう一度お試しください。
        </p>
      )}
    </div>
  );
}

export function FriendDetailPage({ friendId }: { friendId: string }) {
  const date = today();
  const friend = useQuery({
    queryKey: keys.friends.detail(friendId),
    queryFn: () => apiGet(`/api/v1/friends/${encodeURIComponent(friendId)}`, friendSchema),
  });
  const slots = useQuery({ ...friendSlotsQuery(friendId, date), enabled: friend.isSuccess });

  if (friend.error instanceof ApiError && friend.error.status === 404) {
    return (
      <SheetScreen title="友達" label="友達" parent="/friends">
        <p role="status">この友達は見つかりませんでした。</p>
        <ButtonLink to="/friends">友達一覧へ</ButtonLink>
      </SheetScreen>
    );
  }
  const name = friend.data ? displayNameOf(friend.data.displayName) : "友達";

  return (
    <SheetScreen
      label={name}
      parent="/friends"
      title={
        <div className="flex items-center gap-4">
          {friend.data && <Avatar name={friend.data.displayName} src={friend.data.avatarUrl} size="l" />}
          <h2 className="text-xl font-bold">{name}</h2>
        </div>
      }
    >
      {friend.isPending && <Loading />}
      {friend.isError && <LoadError text="読み込めませんでした。通信状態を確認して、もう一度お試しください。" retry={() => void friend.refetch()} />}
      {friend.data && (
        <Section title="見えているここ暇" aside="今日から14日">
          {slots.data?.items.length === 0 && <p className="text-ink-muted">見えているここ暇はありません</p>}
          <ul aria-label="友達のここ暇" className="flex flex-col">
            {slots.data?.items.map((s) => (
              <li key={s.startsAt} className="flex items-center gap-3 border-b border-line py-2 last:border-b-0">
                <span className="w-24 shrink-0 tabular-nums">{formatDate(localDateOf(s.startsAt))}</span>
                <AvailabilityChip text={formatSlot(s)} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {friend.data && <FriendWishList friendId={friendId} />}
      {friend.data && (
        <ButtonLink to={`/invites/new?friend=${encodeURIComponent(friendId)}`} variant="primary" block>
          ここどう？と誘う
        </ButtonLink>
      )}
      {friend.data && <Settings friend={friend.data} />}
    </SheetScreen>
  );
}
