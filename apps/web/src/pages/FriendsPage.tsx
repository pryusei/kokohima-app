import { friendPageSchema, inviteLinkPageSchema, type Friend, type InviteLink } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { InviteLinkSheet } from "../account/InviteLinkSheet";
import { displayNameOf } from "../account/me";
import { Avatar } from "../ui/Avatar";
import { Button, SendButton } from "../ui/Button";
import { EmptyState, LoadError, Loading, Note } from "../ui/feedback";
import { Link } from "../ui/Link";
import { Section, TabScreen } from "../ui/Navigation";
import { MotionRow, useRowExits } from "../ui/RowMotion";
import { Switch } from "../ui/Switch";

// 友達タブ（docs/specs/T-02-friends.md「画面」、キャンバス「7 友達」「17 招待リンクの発行」）

type FriendPage = { items: Friend[]; nextCursor: string | null };


function FriendRow({ friend }: { friend: Friend }) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);

  // 「自分の暇を見せる」は楽観的更新（data-fetching スキル）
  const toggle = useMutation({
    mutationFn: (sharesMyAvailability: boolean) =>
      apiSend("PATCH", `/api/v1/friends/${friend.id}`, { sharesMyAvailability }),
    onMutate: async (sharesMyAvailability) => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: keys.friends.list() });
      const previous = queryClient.getQueryData<FriendPage>(keys.friends.list());
      queryClient.setQueryData<FriendPage>(keys.friends.list(), (page) =>
        page && {
          ...page,
          items: page.items.map((f) => (f.id === friend.id ? { ...f, sharesMyAvailability } : f)),
        },
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(keys.friends.list(), context.previous);
      setFailed(true);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.friends.list() }),
  });

  const name = displayNameOf(friend.displayName);
  return (
    // 押している間は地を沈める（docs/specs/T-56-motion.md「M-11」）。一覧の左右の余白まで沈むよう、行を余白の分だけ広げる
    <li className="-mx-4 flex flex-col gap-1 border-b border-line px-4 py-2 last:border-b-0 transition-[background-color] duration-(--duration-press) active:bg-surface-sunken lg:hover:bg-surface-sunken">
      <div className="flex items-center gap-2">
        <Avatar name={friend.displayName} src={friend.avatarUrl} />
        <Link to={`/friends/${friend.id}`} className="min-w-0 flex-1 truncate font-bold text-ink no-underline">
          {name}
        </Link>
      </div>
      <Switch checked={friend.sharesMyAvailability} onChange={(v) => toggle.mutate(v)}>
        自分の暇を見せる
      </Switch>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          保存できませんでした。もう一度お試しください。
        </p>
      )}
    </li>
  );
}

const NO_LINKS: InviteLink[] = [];
const linkKey = (link: InviteLink) => link.id;

function ActiveInviteLinks() {
  const queryClient = useQueryClient();
  const links = useQuery({
    queryKey: keys.inviteLinks.list(),
    queryFn: () => apiGet("/api/v1/invite-links", inviteLinkPageSchema),
  });
  // 無効にした行は閉じて消え、失敗したら元の場所に開いて戻る。発行した行は開いて一度だけ光る（docs/specs/T-56-motion.md「M-10」）
  const exits = useRowExits(links.data?.items ?? NO_LINKS, linkKey);
  const { leave, restore } = exits;
  const revoke = useMutation({
    mutationFn: (id: string) => apiSend("POST", `/api/v1/invite-links/${id}/revoke`, undefined),
    onMutate: (id) => leave(id),
    onError: (_error, id) => restore(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.inviteLinks.list() }),
  });
  if (!links.data || exits.rows.length === 0) return null;
  return (
    <Section title="有効な招待リンク" aside={`${links.data.items.length}件`}>
      <ul className="rounded-l bg-surface px-4 shadow-card">
        {exits.rows.map((row) => (
          <MotionRow
            key={row.key}
            row={row}
            onHidden={exits.hidden}
            onAppeared={exits.appeared}
            className="flex items-center justify-between gap-2 border-b border-line py-3 group-last:border-b-0"
          >
            <span className="tabular-nums">
              {new Date(row.item.expiresAt).toLocaleDateString()}まで・{row.item.uses}/{row.item.maxUses}人
            </span>
            <SendButton variant="ghost" size="s" onClick={() => revoke.mutate(row.item.id)}>
              無効にする
            </SendButton>
          </MotionRow>
        ))}
      </ul>
    </Section>
  );
}

export function FriendsPage() {
  const friends = useQuery({ queryKey: keys.friends.list(), queryFn: () => apiGet("/api/v1/friends", friendPageSchema) });
  const [issuing, setIssuing] = useState(false);

  return (
    <TabScreen title="友達">
      <Button variant="primary" block onClick={() => setIssuing(true)}>
        招待リンクを作る
      </Button>
      <Section title="友達一覧" aside={friends.data ? `${friends.data.items.length}人` : undefined}>
        {friends.isPending && <Loading variant="list" />}
        {friends.isError && <LoadError retry={() => void friends.refetch()} />}
        {friends.data?.items.length === 0 && <EmptyState title="まだ友達はいません" description="招待リンクを作って、友達に送ってください" />}
        {friends.data && friends.data.items.length > 0 && (
          <>
            <ul aria-label="友達一覧" className="kh-fade rounded-l bg-surface px-4 shadow-card">
              {friends.data.items.map((f) => (
                <FriendRow key={f.id} friend={f} />
              ))}
            </ul>
            <Note>「自分の暇を見せる」を切り替えても、相手には通知されません。</Note>
          </>
        )}
      </Section>
      <ActiveInviteLinks />
      <Section title="アカウント">
        <Link to="/settings" className="flex min-h-11 items-center justify-between rounded-l bg-surface px-4 text-ink no-underline shadow-card">
          設定
          <span aria-hidden="true">›</span>
        </Link>
      </Section>
      {issuing && <InviteLinkSheet onClose={() => setIssuing(false)} />}
    </TabScreen>
  );
}
