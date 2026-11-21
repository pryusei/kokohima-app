import {
  directInviteSchema,
  friendPageSchema,
  isValidInviteRange,
  type ExpiresIn,
  type PresetName,
} from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiSend } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import {
  formatTime,
  localDateOf,
  PRESET_LABELS,
  PRESET_NAMES,
} from "../availability/format";
import { friendSlotsQuery, presetsQuery, today } from "../availability/queries";
import { EXPIRES, rangeOf, sendErrorText } from "../invitations/form";
import { KIND_LABELS, nextQuarter } from "../invitations/format";
import { navigate, useLocation } from "../router";
import { SheetScreen } from "../ui/BottomSheet";
import { Badge } from "../ui/Badge";
import { buttonClass, SendButton } from "../ui/Button";
import { inputClass, labelClass } from "../ui/form";
import { displayNameOf } from "../account/me";

// 誘いの作成（docs/specs/T-04-direct-invite.md「画面」、キャンバス「10 誘いの作成」）。送る前のリンクのプレビューは出さない（T-08 決定事項1）
// 後ろに「みんな」を出したシートで開く（docs/specs/T-11-design.md「画面のつながり」）

const MINUTE_MS = 60 * 1000;

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
    <p className="flex items-center gap-2">
      <Badge tone={overlaps ? "lamp" : "pending"}>{KIND_LABELS[overlaps ? "asobo" : "kokodou"]}</Badge>
      <span className="text-s text-ink-muted">
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

  const idempotency = useIdempotencyKey();
  const send = useMutation({
    mutationFn: () => {
      const body = {
        recipientId: friendId,
        startsAt: new Date(range.startsAt).toISOString(),
        endsAt: new Date(range.endsAt).toISOString(),
        area: area.trim() === "" ? null : area,
        message: message.trim() === "" ? null : message,
        url: url.trim() === "" ? null : url.trim(),
        expiresIn,
      };
      const path = "/api/v1/direct-invites";
      return apiSend("POST", path, body, directInviteSchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, body)) });
    },
    onSettled: (_data, error) => idempotency.settle(error),
    onSuccess: async (invite) => {
      await queryClient.invalidateQueries({ queryKey: keys.invites.all() });
      // 送信中にシートを閉じていたら（Esc など）、戻った先の画面を詳細で置き換えない
      if (invite && window.location.pathname === "/invites/new") navigate(`/invites/${invite.id}`, { replace: true });
    },
  });

  const applyPreset = (name: PresetName) => {
    const p = presets.data?.[name];
    if (!p) return;
    setStart(p.start);
    setEnd(p.end === "24:00" ? "00:00" : p.end);
  };

  return (
    <SheetScreen title="誘う" label="誘う" parent="/">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <label className={labelClass}>
          相手
          <select className={inputClass} value={friendId} onChange={(e) => setFriendId(e.target.value)}>
            <option value="">選んでください</option>
            {friends.data?.items.map((f) => (
              <option key={f.id} value={f.id}>
                {displayNameOf(f.displayName)}
              </option>
            ))}
          </select>
        </label>
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
        {friendId !== "" && validRange && (
          <KindPreview friendId={friendId} date={date} startsAt={range.startsAt} endsAt={range.endsAt} />
        )}
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
        <SendButton type="submit" variant="primary" block disabled={send.isPending || friendId === "" || !validRange}>
          誘う
        </SendButton>
        {send.isError && (
          <p role="status" className="text-s text-ink-muted">
            {sendErrorText(send.error)}
          </p>
        )}
      </form>
    </SheetScreen>
  );
}
