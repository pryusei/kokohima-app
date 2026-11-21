import {
  BROADCAST_MAX_RECIPIENTS,
  BROADCAST_MIN_RECIPIENTS,
  broadcastSchema,
  friendPageSchema,
  isValidInviteRange,
  type Broadcast,
  type ExpiresIn,
  type Friend,
  type PresetName,
} from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiGet, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { formatTime, localDateOf, PRESET_LABELS, PRESET_NAMES } from "../availability/format";
import { presetsQuery, today } from "../availability/queries";
import { SheetScreen } from "../ui/BottomSheet";
import { buttonClass, SendButton } from "../ui/Button";
import { LoadError, Loading, Note } from "../ui/feedback";
import { inputClass, labelClass } from "../ui/form";
import { EXPIRES, rangeOf, sendErrorText } from "../invitations/form";
import { nextQuarter } from "../invitations/format";
import { broadcastQuery } from "../invitations/queries";
import { navigate, useLocation } from "../router";
import { displayNameOf } from "./FriendsPage";

// 募集の作成（docs/specs/T-05-broadcast.md「画面」、キャンバス「11 募集の作成」）。後ろに「みんな」を出したシートで開く。「もう一度募集する」は ?from=<募集のID> で開く

const MINUTE_MS = 60 * 1000;

/** 友達全員を読む（宛先の初期値は全員なので、続きのページも読む） */
const everyFriendQuery = () => ({
  queryKey: keys.friends.everyone(),
  queryFn: async () => {
    const items: Friend[] = [];
    let cursor: string | null = null;
    do {
      const path: string = `/api/v1/friends?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await apiGet(path, friendPageSchema);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  },
});

type Initial = {
  recipientIds: string[];
  date: string;
  start: string;
  end: string;
  area: string;
  message: string;
  url: string;
};

/** 初期値。宛先は全員（100人まで）か、再募集なら元の宛先のうち今も友達の人。時間は過ぎていれば空 */
function initialOf(friends: Friend[], from: Broadcast | null, now: number): Initial {
  const friendIds = friends.map((f) => f.id);
  const recipientIds = from
    ? (from.recipients ?? []).map((r) => r.id).filter((id) => friendIds.includes(id))
    : friendIds.slice(0, BROADCAST_MAX_RECIPIENTS);
  const start = from ? Date.parse(from.startsAt) : nextQuarter(now + 60 * MINUTE_MS);
  const end = from ? Date.parse(from.endsAt) : start + 2 * 60 * MINUTE_MS;
  const past = start <= now;
  return {
    recipientIds,
    date: past ? "" : localDateOf(start),
    start: past ? "" : formatTime(start),
    end: past ? "" : formatTime(end),
    area: from?.area ?? "",
    message: from?.message ?? "",
    url: from?.url ?? "",
  };
}

function createErrorText(error: unknown) {
  if (isIdempotencyConflict(error)) return "送信できませんでした。もう一度お試しください";
  if (error instanceof ApiError && error.status === 409) return "送れませんでした。もう一度お試しください";
  if (error instanceof ApiError && error.status === 404) return "送れない友達が含まれていました。宛先を選び直してください";
  return sendErrorText(error);
}

function BroadcastForm({ friends, initial }: { friends: Friend[]; initial: Initial }) {
  const queryClient = useQueryClient();
  const [recipientIds, setRecipientIds] = useState(initial.recipientIds);
  const [date, setDate] = useState(initial.date);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [area, setArea] = useState(initial.area);
  const [message, setMessage] = useState(initial.message);
  const [url, setUrl] = useState(initial.url);
  const [expiresIn, setExpiresIn] = useState<ExpiresIn>("until_start");
  const presets = useQuery(presetsQuery());
  const range = date && start && end ? rangeOf(date, start, end) : null;
  const validRange =
    range !== null &&
    !Number.isNaN(range.startsAt) &&
    isValidInviteRange(new Date(range.startsAt).toISOString(), new Date(range.endsAt).toISOString());
  const enoughRecipients =
    recipientIds.length >= BROADCAST_MIN_RECIPIENTS && recipientIds.length <= BROADCAST_MAX_RECIPIENTS;

  const idempotency = useIdempotencyKey();
  const send = useMutation({
    mutationFn: () => {
      const body = {
        recipientIds,
        startsAt: new Date(range?.startsAt ?? 0).toISOString(),
        endsAt: new Date(range?.endsAt ?? 0).toISOString(),
        area: area.trim() === "" ? null : area,
        message: message.trim() === "" ? null : message,
        url: url.trim() === "" ? null : url.trim(),
        expiresIn,
      };
      const path = "/api/v1/broadcasts";
      return apiSend("POST", path, body, broadcastSchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, body)) });
    },
    onSettled: (_data, error) => idempotency.settle(error),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: keys.broadcasts.all() });
      if (created) navigate(`/broadcasts/${created.id}`, { replace: true });
    },
  });

  const toggle = (id: string, checked: boolean) =>
    setRecipientIds((ids) => (checked ? [...ids, id] : ids.filter((x) => x !== id)));
  const applyPreset = (name: PresetName) => {
    const p = presets.data?.[name];
    if (!p) return;
    setStart(p.start);
    setEnd(p.end === "24:00" ? "00:00" : p.end);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-bold text-ink-muted">宛先（{recipientIds.length}人）</legend>
        {friends.length > BROADCAST_MAX_RECIPIENTS && (
          <p className="text-s text-ink-muted">一度に送れるのは100人までです</p>
        )}
        <ul aria-label="宛先" className="flex max-h-56 flex-col overflow-y-auto rounded-l border border-line px-3">
          {friends.map((f) => (
            <li key={f.id}>
              <label className="flex min-h-11 items-center gap-2 border-b border-line last:border-b-0">
                <input
                  className="size-5 accent-action"
                  type="checkbox"
                  checked={recipientIds.includes(f.id)}
                  onChange={(e) => toggle(f.id, e.target.checked)}
                />
                {displayNameOf(f.displayName)}
              </label>
            </li>
          ))}
        </ul>
        {!enoughRecipients && <p className="text-s text-ink-muted">2人以上を選んでください（1人なら個別に誘えます）</p>}
      </fieldset>
      <label className={labelClass}>
        日付
        <input className={inputClass} type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        {PRESET_NAMES.map((name) => (
          <button key={name} type="button" className={buttonClass("secondary", { size: "s" })} onClick={() => applyPreset(name)}>
            {PRESET_LABELS[name]}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <label className={labelClass}>
          開始
          <input className={inputClass} type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className={labelClass}>
          終了
          <input className={inputClass} type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label className={labelClass}>
        エリア（任意）
        <input className={inputClass} value={area} onChange={(e) => setArea(e.target.value)} />
      </label>
      <label className={labelClass}>
        ひとこと（任意）
        <textarea className={inputClass} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <label className={labelClass}>
        リンク（任意）
        <input type="url" className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className={labelClass}>
        返事の期限
        <select className={inputClass} value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as ExpiresIn)}>
          {EXPIRES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <Note>応じた人は、あなたにも人数だけが表示されます。「決める」と、参加する人どうしに名前が開示されます。</Note>
      <SendButton type="submit" variant="lamp" block disabled={send.isPending || !enoughRecipients || !validRange}>
        募集する
      </SendButton>
      {send.isError && (
        <p role="status" className="text-s text-ink-muted">
          {createErrorText(send.error)}
        </p>
      )}
    </form>
  );
}

export function BroadcastNewPage() {
  const { search } = useLocation();
  const fromId = new URLSearchParams(search).get("from");
  const friends = useQuery(everyFriendQuery());
  const from = useQuery({ ...broadcastQuery(fromId ?? ""), enabled: fromId !== null });
  // 時刻は開いたときに1回だけ読む（描画のたびに時計を読まない）
  const [openedAt] = useState(() => Date.now());
  const ready = friends.data && (fromId === null || from.data || from.isError);

  return (
    <SheetScreen title="暇な人いる？と募る" label="暇な人いる？と募る" parent="/">
      {friends.isPending && <Loading />}
      {friends.isError && <LoadError retry={() => void friends.refetch()} />}
      {ready && friends.data && (
        <BroadcastForm friends={friends.data} initial={initialOf(friends.data, from.data ?? null, openedAt)} />
      )}
    </SheetScreen>
  );
}
