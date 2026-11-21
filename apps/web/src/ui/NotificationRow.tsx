import type { ReactNode } from "react";
import { Avatar } from "./Avatar";
import { Link } from "./Link";

// お知らせの1行（デザインシステム「NotificationRow」）。未読は左端の lamp の細い帯と太字だけ（赤を使わない）

type Props = { to: string; text: string; unread: boolean; avatarName: string | null; children?: ReactNode };

export function NotificationRow({ to, text, unread, avatarName, children }: Props) {
  return (
    <li className={`flex gap-3 border-b border-line bg-surface px-4 py-3 ${unread ? "border-l-4 border-l-lamp" : ""}`}>
      <Avatar name={avatarName} size="s" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Link to={to} className={`no-underline ${unread ? "font-bold text-ink" : "text-ink"}`}>
          {text}
        </Link>
        {children}
      </div>
    </li>
  );
}
