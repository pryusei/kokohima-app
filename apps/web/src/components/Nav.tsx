import { useQuery } from "@tanstack/react-query";
import type { MouseEvent, ReactNode } from "react";
import { unreadCountQuery } from "../notifications/queries";
import { navigate, useLocation } from "../router";

// 画面の切り替え（仮。最終的なデザインはデザインのタスクで差し替える）

type LinkProps = { to: string; className?: string; current?: boolean; children: ReactNode };

export function Link({ to, className, current, children }: LinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} aria-current={current ? "page" : undefined} onClick={onClick}>
      {children}
    </a>
  );
}

const TABS = [
  { to: "/", label: "みんな" },
  { to: "/availability", label: "ここ暇" },
  { to: "/invites", label: "誘い" },
  { to: "/friends", label: "友達" },
  { to: "/notifications", label: "お知らせ" },
];

export function Nav() {
  const { pathname } = useLocation();
  // 未読の数（赤を使わない）。読めなくてもナビは出す
  const unread = useQuery(unreadCountQuery()).data?.count ?? 0;
  return (
    <nav aria-label="タブ" className="flex gap-4 border-b border-slate-200 pb-2">
      {TABS.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          current={pathname === t.to}
          className={pathname === t.to ? "font-bold text-slate-900" : "text-slate-600 underline"}
        >
          {t.label}
          {t.to === "/notifications" && unread > 0 && (
            <span className="ml-1 rounded-full bg-slate-200 px-2 text-sm text-slate-900" aria-label={`未読${unread}件`}>
              {unread}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
