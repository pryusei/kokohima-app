import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../router";

type LinkProps = { to: string; className?: string; current?: boolean; "aria-label"?: string; children: ReactNode };

/** アプリの中の移動。修飾キー付きのクリックはブラウザに任せる */
export function Link({ to, className, current, children, ...rest }: LinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} aria-current={current ? "page" : undefined} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
