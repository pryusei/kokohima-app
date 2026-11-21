import { myAvailabilitySchema, type FreeSlot } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { formatDate, formatSlot } from "../availability/format";
import { today } from "../availability/queries";
import { SendButton } from "../ui/Button";
import { Link } from "../ui/Link";
import { Section } from "../ui/Navigation";
import { connectionsQuery, freeSlotsQuery } from "./queries";

// ここ暇タブの「カレンダーの空き」（docs/specs/T-06-calendar.md「画面」）。連携している人だけに出す
// 押すと T-03 のここ暇を作る。楽観的更新はせず、成功したら自分の一覧と候補を読み直す

export function CalendarCandidates() {
  const connections = useQuery(connectionsQuery());
  const status = connections.data?.google.status;
  if (status !== "connected" && status !== "needs_reauth") return null;
  return (
    <Section title="カレンダーの空き" aside="Googleカレンダーから">
      {status === "needs_reauth" ? <Reauth /> : <Candidates />}
    </Section>
  );
}

function Candidates() {
  const queryClient = useQueryClient();
  const [date] = useState(today);
  const slots = useQuery(freeSlotsQuery(date));
  const [failed, setFailed] = useState(false);

  const idempotency = useIdempotencyKey();
  const create = useMutation({
    mutationFn: (slot: FreeSlot) => {
      const path = "/api/v1/availabilities";
      const body = { date: slot.date, preset: slot.preset };
      return apiSend("POST", path, body, myAvailabilitySchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, body)) });
    },
    onMutate: () => setFailed(false),
    onError: () => setFailed(true),
    onSettled: (_data, error) => idempotency.settle(error),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.availability.all() }),
  });

  const data = slots.data;
  // 回数の上限（429。T-10）は、候補を出さずに静かに待ってもらう
  if (slots.error instanceof ApiError && slots.error.status === 429) {
    return (
      <p role="status" className="text-ink-muted">
        少し待ってから、もう一度開いてください
      </p>
    );
  }
  if (!data) return null;
  if (data.status === "needs_reauth") return <Reauth />;
  if (data.status === "unavailable") return <p className="text-ink-muted">カレンダーを読み込めませんでした</p>;
  if (data.items.length === 0) return <p className="text-ink-muted">この先7日間に空いている時間帯はありません</p>;
  return (
    <>
      <ul className="rounded-l bg-surface px-4 shadow-card">
        {data.items.map((slot) => {
          const text = `${formatDate(slot.date)} ${formatSlot({ startsAt: slot.startsAt, endsAt: slot.endsAt, label: slot.preset })}`;
          return (
            <li key={`${slot.date}-${slot.preset}`} className="flex items-center gap-2 border-b border-line py-3 last:border-b-0">
              <span className="min-w-0 flex-1 tabular-nums">{text}</span>
              <SendButton size="s" aria-label={`${text}をここ暇にする`} disabled={create.isPending} onClick={() => create.mutate(slot)}>
                ここ暇にする
              </SendButton>
            </li>
          );
        })}
      </ul>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          作れませんでした。もう一度お試しください
        </p>
      )}
    </>
  );
}

function Reauth() {
  return (
    <p className="text-ink-muted">
      カレンダーの連携が切れています。
      <Link to="/settings/calendar" className="text-action underline">
        設定
      </Link>
      からもう一度連携してください
    </p>
  );
}
