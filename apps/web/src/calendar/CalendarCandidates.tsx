import { myAvailabilitySchema, type FreeSlot } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { formatDate, formatSlot } from "../availability/format";
import { today } from "../availability/queries";
import { Link } from "../components/Nav";
import { connectionsQuery, freeSlotsQuery } from "./queries";

// ここ暇タブの「カレンダーの空き」（docs/specs/T-06-calendar.md「画面」）。連携している人だけに出す
// 押すと T-03 のここ暇を作る。楽観的更新はせず、成功したら自分の一覧と候補を読み直す

export function CalendarCandidates() {
  const connections = useQuery(connectionsQuery());
  const status = connections.data?.google.status;
  if (status !== "connected" && status !== "needs_reauth") return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold">カレンダーの空き</h2>
      {status === "needs_reauth" ? (
        <p className="text-slate-600">
          カレンダーの連携が切れています。<Link to="/settings/calendar" className="underline">設定</Link>
          からもう一度連携してください
        </p>
      ) : (
        <Candidates />
      )}
    </section>
  );
}

function Candidates() {
  const queryClient = useQueryClient();
  const [date] = useState(today);
  const slots = useQuery(freeSlotsQuery(date));
  const [failed, setFailed] = useState(false);

  const create = useMutation({
    mutationFn: (slot: FreeSlot) =>
      apiSend("POST", "/api/v1/availabilities", { date: slot.date, preset: slot.preset }, myAvailabilitySchema),
    onMutate: () => setFailed(false),
    onError: () => setFailed(true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.availability.all() }),
  });

  const data = slots.data;
  if (!data) return null;
  if (data.status === "needs_reauth") {
    return (
      <p className="text-slate-600">
        カレンダーの連携が切れています。<Link to="/settings/calendar" className="underline">設定</Link>
        からもう一度連携してください
      </p>
    );
  }
  if (data.status === "unavailable") return <p className="text-slate-600">カレンダーを読み込めませんでした</p>;
  if (data.items.length === 0) return <p className="text-slate-600">この先7日間に空いている時間帯はありません</p>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {data.items.map((slot) => {
          const text = `${formatDate(slot.date)} ${formatSlot({ startsAt: slot.startsAt, endsAt: slot.endsAt, label: slot.preset })}`;
          return (
            <li key={`${slot.date}-${slot.preset}`}>
              <button
                type="button"
                className="w-full rounded-lg border px-4 py-2 text-left"
                disabled={create.isPending}
                onClick={() => create.mutate(slot)}
              >
                {text}
              </button>
            </li>
          );
        })}
      </ul>
      {failed && (
        <p role="status" className="text-sm text-slate-600">
          作れませんでした。もう一度お試しください
        </p>
      )}
    </>
  );
}
