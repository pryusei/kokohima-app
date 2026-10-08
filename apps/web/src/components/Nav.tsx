import type { MouseEvent, ReactNode } from "react";
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
  { to: "/friends", label: "友達" },
];

export function Nav() {
  const { pathname } = useLocation();
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
        </Link>
      ))}
    </nav>
  );
}
