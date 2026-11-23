import { WISH_MAX_ACTIVE, wishSchema, type Friend, type Wish } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { everyFriendQuery } from "../account/friends";
import { displayNameOf } from "../account/me";
import { ApiError, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { BottomSheet } from "../ui/BottomSheet";
import { Button, ButtonLink, SendButton } from "../ui/Button";
import { EmptyState, LoadError, Loading, Note } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";
import { Section } from "../ui/Navigation";
import { myWishesQuery } from "./queries";
import { WishCard } from "./WishCard";

// ここ暇タブの「行きたい」の欄（docs/specs/T-22-wishlist.md「画面」）。置く・見せる相手・消すのシートは URL を持たない

export const FULL_TEXT = `置けるのは${WISH_MAX_ACTIVE}件までです。消すとまた置けます`;
export const RESTORE_NOTE = "戻すと、外していたことに気づかれることがあります";

function createErrorText(error: unknown) {
  if (isIdempotencyConflict(error)) return "置けませんでした。もう一度お試しください";
  if (error instanceof ApiError && error.status === 429) return "今日はたくさん置いたので、少し時間をおいてください";
  if (error instanceof ApiError && error.status === 409) return FULL_TEXT;
  if (error instanceof ApiError && error.status === 404) return "置けませんでした。見せない相手を選び直してください";
  if (error instanceof ApiError && error.status === 400) {
    return "置けませんでした。ひとこと（100文字まで）・エリア（30文字まで）・リンク（http・https）を確かめてください";
  }
  return "置けませんでした。通信状態を確認して、もう一度お試しください";
}

/** 外す人のうち、今の友達の一覧にいる人だけ */
const onlyFriends = (ids: string[], friends: Friend[] | undefined) => {
  const current = new Set((friends ?? []).map((f) => f.id));
  return ids.filter((id) => current.has(id));
};

/** 404（友達でない人が含まれていた）なら、友達の一覧を読み直して選び直せるようにする */
function reloadFriendsOn404(queryClient: ReturnType<typeof useQueryClient>, error: unknown) {
  if (error instanceof ApiError && error.status === 404) void queryClient.invalidateQueries({ queryKey: keys.friends.all() });
}

/** 外す人を選ぶ一覧。excluded にある人のチェックが外れている（見せない） */
function AudiencePicker({
  friends,
  excluded,
  onChange,
  restoredNote,
}: {
  friends: Friend[];
  excluded: string[];
  onChange: (ids: string[]) => void;
  restoredNote: boolean;
}) {
  const toggle = (id: string, shown: boolean) => onChange(shown ? excluded.filter((x) => x !== id) : [...excluded, id]);
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-bold text-ink-muted">見せる相手（チェックを外した人には見えません）</legend>
      <ul aria-label="見せる相手" className="flex max-h-56 flex-col overflow-y-auto rounded-l border border-line px-3">
        {friends.map((f) => (
          <li key={f.id}>
            <label className="flex min-h-11 items-center gap-2 border-b border-line last:border-b-0">
              <input
                className="size-5 accent-action"
                type="checkbox"
                checked={!excluded.includes(f.id)}
                onChange={(e) => toggle(f.id, e.target.checked)}
              />
              {displayNameOf(f.displayName)}
            </label>
          </li>
        ))}
      </ul>
      {restoredNote && <Note>{RESTORE_NOTE}</Note>}
    </fieldset>
  );
}

function AddWishSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [area, setArea] = useState("");
  const [url, setUrl] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const friends = useQuery({ ...everyFriendQuery(), enabled: choosing });

  const idempotency = useIdempotencyKey();
  const create = useMutation({
    mutationFn: () => {
      const body = {
        message,
        area: area.trim() === "" ? null : area,
        url: url.trim() === "" ? null : url.trim(),
        // 今の友達の一覧にいる人だけを送る（外したあとに友達でなくなった人が残ると、404が直らない）
        excludedUserIds: choosing ? onlyFriends(excluded, friends.data) : [],
      };
      const path = "/api/v1/wishes";
      return apiSend("POST", path, body, wishSchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, body)) });
    },
    onSettled: (_data, error) => idempotency.settle(error),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.wishes.all() });
      onClose();
    },
    onError: (error) => reloadFriendsOn404(queryClient, error),
  });

  return (
    <BottomSheet title="行きたいを置く" label="行きたいを置く" onClose={onClose}>
      <Note>日時を決めずに置いておけます。友達はこれを見て誘えます。置いても友達には通知しません。</Note>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="ひとこと">
          <textarea
            className={inputClass}
            value={message}
            placeholder="〇〇のラーメン行きたい"
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>
        <Field label="リンク（任意）">
          <input type="url" className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="エリア（任意）">
          <input className={inputClass} value={area} onChange={(e) => setArea(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold text-ink-muted">見せる相手</span>
          {choosing ? (
            <>
              {friends.isPending && <Loading />}
              {friends.isError && <LoadError retry={() => void friends.refetch()} />}
              {friends.data && <AudiencePicker friends={friends.data} excluded={excluded} onChange={setExcluded} restoredNote={false} />}
            </>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span>友達全員</span>
              <Button size="s" variant="ghost" onClick={() => setChoosing(true)}>
                外す人を選ぶ
              </Button>
            </div>
          )}
        </div>
        <SendButton type="submit" variant="lamp" block disabled={create.isPending || message.trim() === ""}>
          置く
        </SendButton>
        {create.isError && (
          <p role="status" className="text-s text-ink-muted">
            {createErrorText(create.error)}
          </p>
        )}
      </form>
    </BottomSheet>
  );
}

function AudienceSheet({ wish, onClose }: { wish: Wish; onClose: () => void }) {
  const queryClient = useQueryClient();
  const initial = (wish.excludedUsers ?? []).map((u) => u.id);
  const [excluded, setExcluded] = useState(initial);
  const friends = useQuery(everyFriendQuery());
  const restored = initial.some((id) => !excluded.includes(id));

  const save = useMutation({
    mutationFn: () =>
      apiSend("PUT", `/api/v1/wishes/${wish.id}/exclusions`, { userIds: onlyFriends(excluded, friends.data) }, wishSchema),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.wishes.all() });
      onClose();
    },
    onError: (error) => reloadFriendsOn404(queryClient, error),
  });

  return (
    <BottomSheet title="見せる相手" label="見せる相手" onClose={onClose}>
      {friends.isPending && <Loading />}
      {friends.isError && <LoadError retry={() => void friends.refetch()} />}
      {friends.data && <AudiencePicker friends={friends.data} excluded={excluded} onChange={setExcluded} restoredNote={restored} />}
      <SendButton variant="primary" block disabled={save.isPending || !friends.data} onClick={() => save.mutate()}>
        保存する
      </SendButton>
      {save.isError && (
        <p role="status" className="text-s text-ink-muted">
          保存できませんでした。もう一度お試しください。
        </p>
      )}
    </BottomSheet>
  );
}

function DeleteSheet({ wish, onClose }: { wish: Wish; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/v1/wishes/${wish.id}`, undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.wishes.all() });
      onClose();
    },
  });
  return (
    <BottomSheet title="行きたいを消す" label="行きたいを消す" onClose={onClose}>
      <p className="whitespace-pre-line">{wish.message}</p>
      <Note>消すと、友達にも見えなくなります。</Note>
      <SendButton block disabled={remove.isPending} onClick={() => remove.mutate()}>
        消す
      </SendButton>
      <Button variant="ghost" block onClick={onClose}>
        やめる
      </Button>
      {remove.isError && (
        <p role="status" className="text-s text-ink-muted">
          消せませんでした。もう一度お試しください。
        </p>
      )}
    </BottomSheet>
  );
}

type Open = { kind: "add" } | { kind: "audience"; wish: Wish } | { kind: "delete"; wish: Wish } | null;

export function MyWishes() {
  const wishes = useQuery(myWishesQuery());
  const [open, setOpen] = useState<Open>(null);
  const items = wishes.data?.items ?? [];
  const full = items.length >= WISH_MAX_ACTIVE;
  const close = () => setOpen(null);

  return (
    <Section
      title="行きたい"
      aside={
        <Button variant="ghost" size="s" disabled={!wishes.data || full} onClick={() => setOpen({ kind: "add" })}>
          ＋ 行きたいを置く
        </Button>
      }
    >
      {full && <Note>{FULL_TEXT}</Note>}
      {wishes.isPending && <Loading />}
      {wishes.isError && <LoadError retry={() => void wishes.refetch()} />}
      {wishes.data?.items.length === 0 && (
        <EmptyState title="行きたいはまだありません" description="行きたい店やしたいことを置いておくと、友達がそれを見て誘えます" />
      )}
      {items.length > 0 && (
        <ul aria-label="自分の行きたい" className="rounded-l bg-surface px-4 shadow-card">
          {items.map((wish) => (
            <li key={wish.id}>
              <WishCard
                wish={wish}
                actions={
                  <>
                    <ButtonLink to={`/invites/new?wish=${encodeURIComponent(wish.id)}`} size="s">
                      誘う
                    </ButtonLink>
                    <ButtonLink to={`/broadcasts/new?wish=${encodeURIComponent(wish.id)}`} size="s">
                      募集する
                    </ButtonLink>
                    <Button variant="ghost" size="s" onClick={() => setOpen({ kind: "audience", wish })}>
                      見せる相手
                    </Button>
                    <Button variant="ghost" size="s" onClick={() => setOpen({ kind: "delete", wish })}>
                      消す
                    </Button>
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {open?.kind === "add" && <AddWishSheet onClose={close} />}
      {open?.kind === "audience" && <AudienceSheet wish={open.wish} onClose={close} />}
      {open?.kind === "delete" && <DeleteSheet wish={open.wish} onClose={close} />}
    </Section>
  );
}
