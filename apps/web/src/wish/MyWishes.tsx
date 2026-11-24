import { WISH_MAX_ACTIVE, wishSchema, type Friend, type Wish } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { everyFriendQuery } from "../account/friends";
import { displayNameOf } from "../account/me";
import { ApiError, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { BottomSheet } from "../ui/BottomSheet";
import { Button, ButtonLink, SendButton } from "../ui/Button";
import { SubmitButton, useSubmitState } from "../ui/SubmitButton";
import { LoadError, Loading, Note } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";
import { LinkCard } from "../ui/LinkCard";
import { Section } from "../ui/Navigation";
import { myWishesQuery } from "./queries";
import { suggestionQuotaQuery } from "./suggest";
import { SuggestSheet, type PlaceDraft } from "./SuggestSheet";

// ここ暇タブの「行きたい」の欄（docs/specs/T-22-wishlist.md「画面」、並べ方は docs/specs/T-55-availability-week-grid.md）。置く・見せる相手・消すのシートは URL を持たない

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

/** draft：AIの提案の候補から開いたときの値（T-29）。置く処理は同じ */
function AddWishSheet({ onClose, draft }: { onClose: () => void; draft?: PlaceDraft }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState(draft?.message ?? "");
  const [area, setArea] = useState(draft?.area ?? "");
  const [url, setUrl] = useState(draft?.url ?? "");
  const [choosing, setChoosing] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const friends = useQuery({ ...everyFriendQuery(), enabled: choosing });

  const [dismiss, setDismiss] = useState(false);
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
      // 「✓ 置きました」を短く見せてから、出る動きで閉じる（docs/specs/T-56-motion.md「M-03」）
      submit.succeed(() => setDismiss(true));
    },
    onError: (error) => reloadFriendsOn404(queryClient, error),
  });
  const submit = useSubmitState(create.isPending);

  return (
    <BottomSheet title="行きたいを置く" label="行きたいを置く" onClose={onClose} dismiss={dismiss}>
      {draft && <Note>候補から入れました。直してから置けます。</Note>}
      <Note>日時を決めずに置いておけます。友達はこれを見て誘えます。置いても友達には通知しません。</Note>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (submit.state === "ready") create.mutate();
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
        <SubmitButton state={submit.state} variant="lamp" sending="置いています…" done="置きました" disabled={message.trim() === ""}>
          置く
        </SubmitButton>
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
      <SendButton variant="primary" block disabled={!friends.data} pending={save.isPending} onClick={() => save.mutate()}>
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
      <SendButton block pending={remove.isPending} onClick={() => remove.mutate()}>
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

type Open =
  | { kind: "add"; draft?: PlaceDraft }
  | { kind: "suggest" }
  | { kind: "audience"; wish: Wish }
  | { kind: "delete"; wish: Wish }
  | null;

/** 行きたいの欄の頭の「AIでお店を探す」（T-29 の入口。何を探すかを添える。docs/specs/T-55-availability-week-grid.md「振る舞い 5.」） */
function SuggestCard({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const hint = useId();
  return (
    <button
      type="button"
      aria-label="AIでお店を探す"
      aria-describedby={hint}
      disabled={disabled}
      onClick={onClick}
      className={`grid w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-l p-3 text-left ${
        disabled ? "bg-surface-sunken text-ink-disabled" : "bg-meet-soft text-meet-ink"
      }`}
    >
      <span aria-hidden="true" className={`grid size-10 place-items-center rounded-full ${disabled ? "bg-line text-surface" : "bg-meet text-on-meet"}`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="m15 15 5 5" />
        </svg>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className={`font-bold ${disabled ? "text-ink-disabled" : "text-ink"}`}>AIでお店を探す</span>
        <span id={hint} className="text-xs">
          エリアとしたいことから、お店や場所の候補を探します
        </span>
      </span>
      <span aria-hidden="true" className="text-l">
        ›
      </span>
    </button>
  );
}

/** 横にめくる1枚。ボタンは2列×2行に固定し、幅で折り返さない */
function MyWishCard({ wish, onAudience, onDelete }: { wish: Wish; onAudience: () => void; onDelete: () => void }) {
  return (
    <li className="flex w-56 shrink-0 snap-start flex-col gap-2 rounded-l bg-surface p-3 shadow-card">
      <p className="line-clamp-3 font-bold whitespace-pre-line">{wish.message}</p>
      {wish.area && <p className="truncate text-s text-ink-muted">エリア：{wish.area}</p>}
      <LinkCard url={wish.url} preview={wish.linkPreview} compact />
      <div className="mt-auto grid grid-cols-2 gap-2 pt-1">
        <ButtonLink to={`/invites/new?wish=${encodeURIComponent(wish.id)}`} size="s">
          誘う
        </ButtonLink>
        <ButtonLink to={`/broadcasts/new?wish=${encodeURIComponent(wish.id)}`} size="s">
          募集する
        </ButtonLink>
        <Button variant="ghost" size="s" onClick={onAudience}>
          見せる相手
        </Button>
        <Button variant="ghost" size="s" onClick={onDelete}>
          消す
        </Button>
      </div>
    </li>
  );
}

export function MyWishes() {
  const wishes = useQuery(myWishesQuery());
  // 設定がない（limit 0）・読めないときは「AIでお店を探す」を出さない（T-29）
  const quota = useQuery(suggestionQuotaQuery());
  const canSuggest = (quota.data?.limit ?? 0) > 0;
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
      {canSuggest && <SuggestCard disabled={!wishes.data || full} onClick={() => setOpen({ kind: "suggest" })} />}
      {full && <Note>{FULL_TEXT}</Note>}
      {wishes.isPending && <Loading />}
      {wishes.isError && <LoadError retry={() => void wishes.refetch()} />}
      {wishes.data?.items.length === 0 && (
        <div className="flex flex-col gap-1 rounded-l border border-dashed border-line-strong px-4 py-3">
          <p className="font-bold">行きたいはまだありません</p>
          <Note>行きたい店やしたいことを置いておくと、友達がそれを見て誘えます</Note>
        </div>
      )}
      {items.length > 0 && (
        // 横にめくる。件数で縦に伸びない（docs/specs/T-55-availability-week-grid.md「振る舞い 5.」）
        <ul aria-label="自分の行きたい" className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pt-0.5 pb-2 lg:-mx-6 lg:scroll-px-6 lg:px-6">
          {items.map((wish) => (
            <MyWishCard
              key={wish.id}
              wish={wish}
              onAudience={() => setOpen({ kind: "audience", wish })}
              onDelete={() => setOpen({ kind: "delete", wish })}
            />
          ))}
        </ul>
      )}
      {open?.kind === "add" && <AddWishSheet onClose={close} draft={open.draft} />}
      {open?.kind === "suggest" && <SuggestSheet onClose={close} onPlace={(draft) => setOpen({ kind: "add", draft })} />}
      {open?.kind === "audience" && <AudienceSheet wish={open.wish} onClose={close} />}
      {open?.kind === "delete" && <DeleteSheet wish={open.wish} onClose={close} />}
    </Section>
  );
}
