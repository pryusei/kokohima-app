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
import { EmptyState, FadeIn, LoadError, Loading } from "../ui/feedback";
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
    <FadeIn>
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
    </FadeIn>
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
      {/* 読み込みのあと最初に描く一覧はフェードで入る（M-06。外の Broadcasts の FadeIn は切り替えの中身で、読み込みより先に描く） */}
      {broadcasts.data && (
        <ul aria-label={label} className="kh-fade flex flex-col gap-4">
          {broadcasts.data.items.map((b) => (
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
      )}
    </Section>
  );
}

function Broadcasts() {
  return (
    <FadeIn className="flex flex-col gap-6">
      <ButtonLink to="/broadcasts/new" variant="lamp" block>
        暇な人いる？と募る
      </ButtonLink>
      <BroadcastList box="sent" />
      <BroadcastList box="received" />
    </FadeIn>
  );
}

function MeetupList() {
  const meetups = useQuery(meetupsQuery());
  if (meetups.isPending) return <Loading />;
  if (meetups.isError) return <LoadError retry={() => void meetups.refetch()} />;
  if (meetups.data.items.length === 0) return <EmptyState title="これからの成立した予定はありません" />;
  return (
    <FadeIn>
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
    </FadeIn>
  );
}

/** search は ?tab= を含む URL の検索部分。シートの後ろに出すときは、開いたときの値を App が渡す */
export function InvitesPage({ search }: { search: string }) {
  const requested = new URLSearchParams(search).get("tab");
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : "received";
  const index = TABS.findIndex((t) => t.id === tab);

  return (
    <TabScreen title="誘い">
      <nav aria-label="誘いの一覧" className="relative grid grid-cols-4 gap-1 rounded-m bg-surface-sunken p-1">
        {/* 白い板は1枚で、今の項目の下へ滑る（docs/specs/T-56-motion.md「M-08」）。幅は項目と同じ（4分の1から隙間を引いたもの）、
            1つ動くごとに自分の幅と隙間（0.25rem）の分ずれる。最初の描画では動かない（transition だけ） */}
        <span
          aria-hidden="true"
          data-testid="segment-plate"
          className="absolute inset-y-1 left-1 w-[calc((100%-1.25rem)/4)] rounded-s bg-surface shadow-card transition-transform duration-(--duration-base) ease-out"
          style={{ transform: `translateX(calc(${index} * (100% + 0.25rem)))` }}
        />
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={`/invites?tab=${t.id}`}
            current={tab === t.id}
            className={`relative rounded-s py-1.5 text-center font-bold no-underline ${tab === t.id ? "text-ink" : "text-ink-muted"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {/* 中身は切り替えるたびに作り直し、フェードで入る（FadeIn） */}
      {tab === "meetups" ? <MeetupList key={tab} /> : tab === "broadcasts" ? <Broadcasts key={tab} /> : <InviteList key={tab} box={tab} />}
    </TabScreen>
  );
}
