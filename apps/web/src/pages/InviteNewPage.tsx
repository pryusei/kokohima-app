import {
  directInviteSchema,
  friendPageSchema,
  isValidInviteRange,
  type ExpiresIn,
  type PresetName,
} from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import {
  addDays,
  formatTime,
  localDateOf,
  localInstant,
  PRESET_LABELS,
  PRESET_NAMES,
} from "../availability/format";
import { friendSlotsQuery, presetsQuery, today } from "../availability/queries";
import { Nav } from "../components/Nav";
import { KIND_LABELS, nextQuarter } from "../invitations/format";
import { navigate, useLocation } from "../router";
import { displayNameOf } from "./FriendsPage";

// 誘いの作成（仮。docs/specs/T-04-direct-invite.md「画面」）

const EXPIRES: { value: ExpiresIn; label: string }[] = [
  { value: "until_start", label: "開始まで" },
  { value: "1h", label: "1時間" },
  { value: "3h", label: "3時間" },
  { value: "24h", label: "24時間" },
];
const MINUTE_MS = 60 * 1000;

function sendErrorText(error: unknown) {
  if (error instanceof ApiError && error.status === 429) return "今日はたくさん誘ったので、少し時間をおいてください";
  if (error instanceof ApiError && error.status === 409) return "同じ時間の誘いをもう送っています";
  if (error instanceof ApiError && error.status === 404) return "この友達には送れませんでした";
  if (error instanceof ApiError && error.status === 400) {
    return "送れませんでした。これからの時間で、15分単位、30分以上24時間以内にしてください。文字数も確かめてください";
  }
  return "送れませんでした。通信状態を確認して、もう一度お試しください";
}

/** 日付と開始・終了（HH:MM）から瞬間を作る。終了が開始以前なら翌日 */
function rangeOf(date: string, start: string, end: string) {
  const startsAt = localInstant(date, start);
  let endsAt = localInstant(date, end);
  if (endsAt <= startsAt) endsAt = localInstant(addDays(date, 1), end);
  return { startsAt, endsAt };
}

function initialFields(search: string) {
  const params = new URLSearchParams(search);
  const startsAt = Date.parse(params.get("startsAt") ?? "");
  const endsAt = Date.parse(params.get("endsAt") ?? "");
  const start = Number.isNaN(startsAt) ? nextQuarter(Date.now() + 60 * MINUTE_MS) : startsAt;
  const end = Number.isNaN(endsAt) ? start + 2 * 60 * MINUTE_MS : endsAt;
  return {
    friendId: params.get("friend") ?? "",
    date: localDateOf(start),
    start: formatTime(start),
    end: formatTime(end),
  };
}

function KindPreview({ friendId, date, startsAt, endsAt }: { friendId: string; date: string; startsAt: number; endsAt: number }) {
  // 画面の表示は見えている枠から。送った結果はサーバーの kind を正とする
  const slots = useQuery({ ...friendSlotsQuery(friendId, date), enabled: friendId !== "" });
  if (!slots.data) return null;
  const overlaps = slots.data.items.some(
    (s) => Math.min(Date.parse(s.endsAt), endsAt) - Math.max(Date.parse(s.startsAt), startsAt) >= MINUTE_MS,
  );
  return (
    <p className={overlaps ? "font-bold text-amber-800" : "font-bold text-slate-700"}>
      <span>{KIND_LABELS[overlaps ? "asobo" : "kokodou"]}</span>
      <span className="ml-2 text-sm font-normal text-slate-600">
        {overlaps ? "相手のここ暇と重なっています" : "相手のここ暇とは重なっていません"}
      </span>
    </p>
  );
}

export function InviteNewPage() {
  const { search } = useLocation();
  const queryClient = useQueryClient();
  const [initial] = useState(() => initialFields(search));
  const [friendId, setFriendId] = useState(initial.friendId);
  const [date, setDate] = useState(initial.date);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [area, setArea] = useState("");
  const [message, setMessage] = useState("");
  const [url, setUrl] = useState("");
  const [expiresIn, setExpiresIn] = useState<ExpiresIn>("until_start");
  const friends = useQuery({ queryKey: keys.friends.list(), queryFn: () => apiGet("/api/v1/friends", friendPageSchema) });
  const presets = useQuery(presetsQuery());
  const range = rangeOf(date, start, end);
  const validRange =
    !Number.isNaN(range.startsAt) &&
    isValidInviteRange(new Date(range.startsAt).toISOString(), new Date(range.endsAt).toISOString());

  const send = useMutation({
    mutationFn: () =>
      apiSend(
        "POST",
        "/api/v1/direct-invites",
        {
          recipientId: friendId,
          startsAt: new Date(range.startsAt).toISOString(),
          endsAt: new Date(range.endsAt).toISOString(),
          area: area.trim() === "" ? null : area,
          message: message.trim() === "" ? null : message,
          url: url.trim() === "" ? null : url.trim(),
          expiresIn,
        },
        directInviteSchema,
      ),
    onSuccess: async (invite) => {
      await queryClient.invalidateQueries({ queryKey: keys.invites.all() });
      if (invite) navigate(`/invites/${invite.id}`);
    },
  });

  const applyPreset = (name: PresetName) => {
    const p = presets.data?.[name];
    if (!p) return;
    setStart(p.start);
    setEnd(p.end === "24:00" ? "00:00" : p.end);
  };

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">誘う</h1>
      <Nav />
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <label className="flex flex-col gap-1">
          相手
          <select value={friendId} onChange={(e) => setFriendId(e.target.value)}>
            <option value="">選んでください</option>
            {friends.data?.items.map((f) => (
              <option key={f.id} value={f.id}>
                {displayNameOf(f.displayName)}
              </option>
            ))}
          </select>
        </label>
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
        {friendId !== "" && validRange && (
          <KindPreview friendId={friendId} date={date} startsAt={range.startsAt} endsAt={range.endsAt} />
        )}
        <label className="flex flex-col gap-1">
          エリア（任意）
          <input className="rounded border px-2 py-1" maxLength={30} value={area} onChange={(e) => setArea(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          ひとこと（任意）
          <textarea className="rounded border px-2 py-1" maxLength={100} value={message} onChange={(e) => setMessage(e.target.value)} />
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
          disabled={send.isPending || friendId === "" || !validRange}
          className="rounded-lg bg-amber-300 px-4 py-3 disabled:opacity-50"
        >
          誘う
        </button>
        {send.isError && (
          <p role="status" className="text-sm text-slate-600">
            {sendErrorText(send.error)}
          </p>
        )}
      </form>
    </main>
  );
}
