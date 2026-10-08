import { useQuery } from "@tanstack/react-query";
import { formatRange, KIND_LABELS, statusClass, statusText } from "../invitations/format";
import { invitesQuery, meetupsQuery } from "../invitations/queries";
import { Link, Nav } from "../components/Nav";
import { useLocation } from "../router";
import { displayNameOf } from "./FriendsPage";

// 誘いタブ（仮。docs/specs/T-04-direct-invite.md「画面」）：受信・送信・成立

const TABS = [
  { id: "received", label: "受信" },
  { id: "sent", label: "送信" },
  { id: "meetups", label: "成立" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function InviteList({ box }: { box: "received" | "sent" }) {
  const invites = useQuery(invitesQuery(box));
  if (invites.isError) return <p className="text-slate-600">読み込めませんでした。もう一度お試しください。</p>;
  if (invites.data?.items.length === 0) {
    return <p className="text-slate-600">{box === "received" ? "まだ誘いは届いていません" : "まだ誘っていません"}</p>;
  }
  return (
    <ul aria-label={box === "received" ? "受信した誘い" : "送信した誘い"} className="flex flex-col gap-2">
      {invites.data?.items.map((invite) => (
        <li key={invite.id} className="rounded-lg border border-slate-200 bg-white p-3">
          <Link to={`/invites/${invite.id}`} className="flex flex-col gap-1">
            <span className="font-bold">
              {displayNameOf(invite.counterpart.displayName)}・{KIND_LABELS[invite.kind]}
            </span>
            <span>{formatRange(invite)}</span>
            <span className={`text-sm ${statusClass(invite.status)}`}>{statusText(invite)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function MeetupList() {
  const meetups = useQuery(meetupsQuery());
  if (meetups.isError) return <p className="text-slate-600">読み込めませんでした。もう一度お試しください。</p>;
  if (meetups.data?.items.length === 0) return <p className="text-slate-600">これからの成立した予定はありません</p>;
  return (
    <ul aria-label="成立した予定" className="flex flex-col gap-2">
      {meetups.data?.items.map((m) => (
        <li key={m.id} className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <Link to={`/meetups/${m.id}`} className="flex flex-col gap-1">
            <span className="font-bold">{m.participants.map((p) => displayNameOf(p.displayName)).join("・")}</span>
            <span>{formatRange(m)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function InvitesPage() {
  const { search } = useLocation();
  const requested = new URLSearchParams(search).get("tab");
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : "received";

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">誘い</h1>
      <Nav />
      <nav aria-label="誘いの一覧" className="flex gap-4">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={`/invites?tab=${t.id}`}
            current={tab === t.id}
            className={tab === t.id ? "font-bold" : "text-slate-600 underline"}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "meetups" ? <MeetupList /> : <InviteList key={tab} box={tab} />}
    </main>
  );
}
