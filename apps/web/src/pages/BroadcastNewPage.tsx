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
import { ApiError, apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { formatTime, localDateOf, PRESET_LABELS, PRESET_NAMES } from "../availability/format";
import { presetsQuery, today } from "../availability/queries";
import { Nav } from "../components/Nav";
import { EXPIRES, rangeOf, sendErrorText } from "../invitations/form";
import { nextQuarter } from "../invitations/format";
import { broadcastQuery } from "../invitations/queries";
import { navigate, useLocation } from "../router";
import { displayNameOf } from "./FriendsPage";

// 募集の作成（仮。docs/specs/T-05-broadcast.md「画面」）。「もう一度募集する」は ?from=<募集のID> で開く

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

  const send = useMutation({
    mutationFn: () =>
      apiSend(
        "POST",
        "/api/v1/broadcasts",
        {
          recipientIds,
          startsAt: new Date(range?.startsAt ?? 0).toISOString(),
          endsAt: new Date(range?.endsAt ?? 0).toISOString(),
          area: area.trim() === "" ? null : area,
          message: message.trim() === "" ? null : message,
          url: url.trim() === "" ? null : url.trim(),
          expiresIn,
        },
        broadcastSchema,
      ),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: keys.broadcasts.all() });
      if (created) navigate(`/broadcasts/${created.id}`);
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
        <legend className="font-bold">宛先（{recipientIds.length}人）</legend>
        {friends.length > BROADCAST_MAX_RECIPIENTS && (
          <p className="text-sm text-slate-600">一度に送れるのは100人までです</p>
        )}
        <ul aria-label="宛先" className="flex flex-col gap-1">
          {friends.map((f) => (
            <li key={f.id}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={recipientIds.includes(f.id)}
                  onChange={(e) => toggle(f.id, e.target.checked)}
                />
                {displayNameOf(f.displayName)}
              </label>
            </li>
          ))}
        </ul>
        {!enoughRecipients && <p className="text-sm text-slate-600">2人以上を選んでください（1人なら個別に誘えます）</p>}
      </fieldset>
      <label className="flex flex-col gap-1">
        日付
        <input type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} />
      </label>
      <div className="flex gap-2">
        {PRESET_NAMES.map((name) => (
          <button key={name} type="button" className="rounded border px-3 py-1" onClick={() => applyPreset(name)}>
            {PRESET_LABELS[name]}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <label className="flex flex-col gap-1">
          開始
          <input type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          終了
          <input type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        エリア（任意）
        <input className="rounded border px-2 py-1" value={area} onChange={(e) => setArea(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        ひとこと（任意）
        <textarea className="rounded border px-2 py-1" value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        リンク（任意）
        <input type="url" className="rounded border px-2 py-1" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        返事の期限
        <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as ExpiresIn)}>
          {EXPIRES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={send.isPending || !enoughRecipients || !validRange}
        className="rounded-lg bg-amber-300 px-4 py-3 disabled:opacity-50"
      >
        募集する
      </button>
      {send.isError && (
        <p role="status" className="text-sm text-slate-600">
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
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">暇な人いる？</h1>
      <Nav />
      {friends.isError && <p className="text-slate-600">読み込めませんでした。もう一度お試しください。</p>}
      {ready && friends.data && (
        <BroadcastForm friends={friends.data} initial={initialOf(friends.data, from.data ?? null, openedAt)} />
      )}
    </main>
  );
}
