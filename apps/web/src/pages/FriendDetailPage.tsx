import { friendSchema } from "@kokohima/shared";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiGet } from "../api/client";
import { keys } from "../api/keys";
import { formatDate, formatSlot, localDateOf } from "../availability/format";
import { friendSlotsQuery, today } from "../availability/queries";
import { navigate } from "../router";
import { AvailabilityChip } from "../ui/AvailabilityChip";
import { Avatar } from "../ui/Avatar";
import { SheetScreen } from "../ui/BottomSheet";
import { ButtonLink } from "../ui/Button";
import { LoadError, Loading } from "../ui/feedback";
import { Section } from "../ui/Navigation";
import { MoreButton, usePersonActionsToggle } from "../safety/MoreButton";
import { PersonActions } from "../safety/PersonActions";
import { displayNameOf } from "../account/me";
import { FriendWishList } from "../wish/FriendWishes";

// 友達の詳細（docs/specs/T-03-availability.md「画面」、キャンバス「16 友達の詳細」）
// 後ろに友達タブを出したシートで開く（docs/specs/T-11-design.md「画面のつながり」）
// 「自分の暇を見せる」と「友達を解除」は、名前の横の「…」のシートに置く（ブロック・通報と同じ所。docs/specs/T-33-block-report.md「振る舞い 1.」）

export function FriendDetailPage({ friendId }: { friendId: string }) {
  const date = today();
  const friend = useQuery({
    queryKey: keys.friends.detail(friendId),
    queryFn: () => apiGet(`/api/v1/friends/${encodeURIComponent(friendId)}`, friendSchema),
  });
  const slots = useQuery({ ...friendSlotsQuery(friendId, date), enabled: friend.isSuccess });
  const { acting, open: openActions, close: closeActions, moreRef } = usePersonActionsToggle();

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
          <h2 className="min-w-0 flex-1 truncate text-xl font-bold">{name}</h2>
          {friend.data && !acting && <MoreButton ref={moreRef} name={name} onClick={openActions} />}
        </div>
      }
    >
      {acting && friend.data && (
        <PersonActions
          person={{ id: friendId, name }}
          onBack={closeActions}
          onDone={(result) => {
            if (result === "reported") closeActions();
            // 友達でなくなったら友達タブへ（解除と同じ）
            else navigate("/friends", { replace: true });
          }}
        />
      )}
      {!acting && friend.isPending && <Loading variant="list" />}
      {!acting && friend.isError && <LoadError text="読み込めませんでした。通信状態を確認して、もう一度お試しください。" retry={() => void friend.refetch()} />}
      {!acting && friend.data && (
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
      {!acting && friend.data && <FriendWishList friendId={friendId} />}
      {/* 重なれば「あそぼ」、重ならなければ「ここどう？」になるので「誘う」とだけ書く（T-34） */}
      {!acting && friend.data && (
        <ButtonLink to={`/invites/new?friend=${encodeURIComponent(friendId)}`} variant="primary" block>
          誘う
        </ButtonLink>
      )}
    </SheetScreen>
  );
}
