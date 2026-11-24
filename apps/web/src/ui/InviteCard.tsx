import type { ReactNode } from "react";
import { Avatar } from "./Avatar";
import { Badge, type Tone } from "./Badge";
import { Link } from "./Link";

// 誘い・募集のカード（デザインシステム「InviteCard」「BroadcastCard」）。状態の見た目は tone の1つの値で渡す
// 成立は上端に meet-soft の帯、静かな状態（quiet）は影をなくして一段下げる

type CardProps = {
  to: string;
  avatarName: string | null;
  avatarUrl?: string | null;
  title: string;
  subtitle: string;
  when: string;
  /** when の下に小さく添える時間（「この時間なら」が返った送信の誘いの「最初の時間 15:00〜17:00」。T-46） */
  whenNote?: string | null;
  note?: string | null;
  status: string;
  tone: Tone;
  children?: ReactNode;
};

function Card({ to, avatarName, avatarUrl = null, title, subtitle, when, whenNote, note, status, tone, children }: CardProps) {
  const look =
    tone === "quiet"
      ? "border border-line bg-surface"
      : tone === "meet"
        ? "border-t-6 border-meet-soft bg-surface shadow-card"
        : "bg-surface shadow-card";
  const ink = tone === "quiet" ? "text-quiet-ink" : "text-ink";
  return (
    <Link to={to} className={`flex flex-col gap-2 rounded-l p-4 no-underline ${look}`}>
      <span className="flex items-center gap-3">
        <Avatar name={avatarName} src={avatarUrl} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate font-bold ${ink}`}>{title}</span>
          <span className="truncate text-s text-ink-muted">{subtitle}</span>
        </span>
        <Badge tone={tone}>{status}</Badge>
      </span>
      <span className="flex flex-col">
        <span className={`text-l font-bold tabular-nums ${ink}`}>{when}</span>
        {whenNote && <span className="text-s text-ink-muted tabular-nums">{whenNote}</span>}
      </span>
      {note && <span className={`line-clamp-2 whitespace-pre-wrap ${ink}`}>{note}</span>}
      {children}
    </Link>
  );
}

export function InviteCard(props: CardProps) {
  return <Card {...props} />;
}

export function BroadcastCard(props: CardProps) {
  return <Card {...props} />;
}
