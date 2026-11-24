import { useQuery } from "@tanstack/react-query";
import {
  broadcastStatusText,
  broadcastStatusTone,
  formatRange,
  inviteTimes,
  KIND_LABELS,
  statusText,
  statusTone,
} from "../invitations/format";
import { broadcastsQuery, invitesQuery, meetupsQuery } from "../invitations/queries";
import { ButtonLink } from "../ui/Button";
import { EmptyState, LoadError, Loading } from "../ui/feedback";
import { BroadcastCard, InviteCard } from "../ui/InviteCard";
import { Link } from "../ui/Link";
import { Section, TabScreen } from "../ui/Navigation";
import { honorificOf, nameOfProfile } from "../account/me";

// 誘いタブ（docs/specs/T-04-direct-invite.md・T-05-broadcast.md「画面」、キャンバス「6 誘い」）：受信・送信・募集・成立

const TABS = [
  { id: "received", label: "受信" },
  { id: "sent", label: "送信" },
  { id: "broadcasts", label: "募集" },
  { id: "meetups", label: "成立" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function InviteList({ box }: { box: "received" | "sent" }) {
  const invites = useQuery(invitesQuery(box));
  if (invites.isPending) return <Loading />;
  if (invites.isError) return <LoadError retry={() => void invites.refetch()} />;
  if (invites.data.items.length === 0) {
    return <EmptyState title={box === "received" ? "まだ誘いは届いていません" : "まだ誘っていません"} />;
  }
  return (
    <ul aria-label={box === "received" ? "受信した誘い" : "送信した誘い"} className="flex flex-col gap-4">
      {invites.data.items.map((invite) => {
        const name = nameOfProfile(invite.counterpart);
        const times = inviteTimes(invite);
        return (
          <li key={invite.id}>
            <InviteCard
              to={`/invites/${invite.id}`}
              avatarName={invite.counterpart.displayName}
              avatarUrl={invite.counterpart.avatarUrl}
              title={box === "sent" ? `${honorificOf(invite.counterpart)}へ` : name}
              subtitle={KIND_LABELS[invite.kind]}
              when={times.when}
              whenNote={times.original}
              note={invite.message}
              status={statusText(invite)}
              tone={statusTone(invite.status)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function BroadcastList({ box }: { box: "received" | "sent" }) {
  const broadcasts = useQuery(broadcastsQuery(box));
  const label = box === "sent" ? "自分の募集" : "受け取った募集";
  return (
    <Section title={label}>
      {broadcasts.isPending && <Loading />}
      {broadcasts.isError && <LoadError retry={() => void broadcasts.refetch()} />}
      {broadcasts.data?.items.length === 0 && <p className="text-ink-muted">まだありません</p>}
      <ul aria-label={label} className="flex flex-col gap-4">
        {broadcasts.data?.items.map((b) => (
          <li key={b.id}>
            <BroadcastCard
              to={`/broadcasts/${b.id}`}
              avatarName={box === "received" ? b.owner.displayName : null}
              avatarUrl={box === "received" ? b.owner.avatarUrl : null}
              title={box === "received" ? `${honorificOf(b.owner)}の募集` : "暇な人いる？"}
              subtitle={box === "received" ? "暇な人いる？" : "自分の募集"}
              when={formatRange(b)}
              note={b.message}
              status={broadcastStatusText(b)}
              tone={broadcastStatusTone(b)}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Broadcasts() {
  return (
    <div className="flex flex-col gap-6">
      <ButtonLink to="/broadcasts/new" variant="lamp" block>
        暇な人いる？と募る
      </ButtonLink>
      <BroadcastList box="sent" />
      <BroadcastList box="received" />
    </div>
  );
}

function MeetupList() {
  const meetups = useQuery(meetupsQuery());
  if (meetups.isPending) return <Loading />;
  if (meetups.isError) return <LoadError retry={() => void meetups.refetch()} />;
  if (meetups.data.items.length === 0) return <EmptyState title="これからの成立した予定はありません" />;
  return (
    <ul aria-label="成立した予定" className="flex flex-col gap-4">
      {meetups.data.items.map((m) => (
        <li key={m.id}>
          <InviteCard
            to={`/meetups/${m.id}`}
            avatarName={m.participants[0]?.displayName ?? null}
            avatarUrl={m.participants[0]?.avatarUrl ?? null}
            title={m.participants.map(nameOfProfile).join("・")}
            subtitle="予定"
            when={formatRange(m)}
            note={m.message}
            status="成立"
            tone="meet"
          />
        </li>
      ))}
    </ul>
  );
}

/** search は ?tab= を含む URL の検索部分。シートの後ろに出すときは、開いたときの値を App が渡す */
export function InvitesPage({ search }: { search: string }) {
  const requested = new URLSearchParams(search).get("tab");
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : "received";

  return (
    <TabScreen title="誘い">
      <nav aria-label="誘いの一覧" className="grid grid-cols-4 gap-1 rounded-m bg-surface-sunken p-1">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={`/invites?tab=${t.id}`}
            current={tab === t.id}
            className={`rounded-s py-1.5 text-center font-bold no-underline ${tab === t.id ? "bg-surface text-ink shadow-card" : "text-ink-muted"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "meetups" ? <MeetupList /> : tab === "broadcasts" ? <Broadcasts /> : <InviteList key={tab} box={tab} />}
    </TabScreen>
  );
}
