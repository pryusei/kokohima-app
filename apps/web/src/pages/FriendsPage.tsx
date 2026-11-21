import {
  createdInviteLinkSchema,
  friendPageSchema,
  inviteLinkPageSchema,
  INVITE_DEFAULTS,
  type CreatedInviteLink,
  type Friend,
} from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { DisplayNameForm } from "../account/DisplayNameForm";
import { displayNameOf, meQuery } from "../account/me";
import { Avatar } from "../ui/Avatar";
import { BottomSheet } from "../ui/BottomSheet";
import { Button, SendButton } from "../ui/Button";
import { EmptyState, LoadError, Loading, Note } from "../ui/feedback";
import { Chip, ChipRow, Field, inputClass } from "../ui/form";
import { Link } from "../ui/Link";
import { Section, TabScreen } from "../ui/Navigation";
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
    <li className="flex flex-col gap-1 border-b border-line py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <Avatar name={friend.displayName} />
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

function InviteLinkSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery());
  const [expiresInDays, setExpiresInDays] = useState<1 | 3 | 7>(INVITE_DEFAULTS.expiresInDays);
  const [maxUses, setMaxUses] = useState<number>(INVITE_DEFAULTS.maxUses);
  const [created, setCreated] = useState<CreatedInviteLink | null>(null);

  const create = useMutation({
    mutationFn: () => apiSend("POST", "/api/v1/invite-links", { expiresInDays, maxUses }, createdInviteLinkSchema),
    onSuccess: (link) => {
      setCreated(link ?? null);
      void queryClient.invalidateQueries({ queryKey: keys.inviteLinks.list() });
    },
  });

  const share = async (url: string) => {
    if (navigator.share) await navigator.share({ url }).catch(() => undefined);
    else await navigator.clipboard?.writeText(url).catch(() => undefined);
  };

  return (
    <BottomSheet title="招待リンクを作る" label="招待リンクを作る" onClose={onClose}>
      {me.data && me.data.displayName === null ? (
        <DisplayNameForm intro="招待リンクを作る前に、友達に表示する名前を決めてください。" />
      ) : (
        <>
          <ChipRow label="使える期間">
            {([1, 3, 7] as const).map((d) => (
              <Chip key={d} selected={expiresInDays === d} onClick={() => setExpiresInDays(d)}>
                {d}日
              </Chip>
            ))}
          </ChipRow>
          <Field label="使える人数">
            <select className={inputClass} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}人
                </option>
              ))}
            </select>
          </Field>
          <SendButton variant="primary" block disabled={create.isPending} onClick={() => create.mutate()}>
            招待リンクを作る
          </SendButton>
          {create.isError && (
            <p role="status" className="text-s text-ink-muted">
              作れませんでした。時間をおいてもう一度お試しください。
            </p>
          )}
          {created && (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <input aria-label="招待リンクのURL" readOnly className={`${inputClass} text-s`} value={created.url} />
              <Button variant="primary" onClick={() => void share(created.url)}>
                共有する
              </Button>
              <Note>このURLはこの画面でしか表示できません。今のうちに友達に送ってください。</Note>
            </div>
          )}
        </>
      )}
    </BottomSheet>
  );
}

function ActiveInviteLinks() {
  const queryClient = useQueryClient();
  const links = useQuery({
    queryKey: keys.inviteLinks.list(),
    queryFn: () => apiGet("/api/v1/invite-links", inviteLinkPageSchema),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiSend("POST", `/api/v1/invite-links/${id}/revoke`, undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.inviteLinks.list() }),
  });
  if (!links.data || links.data.items.length === 0) return null;
  return (
    <Section title="有効な招待リンク" aside={`${links.data.items.length}件`}>
      <ul className="rounded-l bg-surface px-4 shadow-card">
        {links.data.items.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-2 border-b border-line py-3 last:border-b-0">
            <span className="tabular-nums">
              {new Date(l.expiresAt).toLocaleDateString()}まで・{l.uses}/{l.maxUses}人
            </span>
            <SendButton variant="ghost" size="s" onClick={() => revoke.mutate(l.id)}>
              無効にする
            </SendButton>
          </li>
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
        {friends.isPending && <Loading />}
        {friends.isError && <LoadError retry={() => void friends.refetch()} />}
        {friends.data?.items.length === 0 && <EmptyState title="まだ友達はいません" description="招待リンクを作って、友達に送ってください" />}
        {friends.data && friends.data.items.length > 0 && (
          <>
            <ul aria-label="友達一覧" className="rounded-l bg-surface px-4 shadow-card">
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
