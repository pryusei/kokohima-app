import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../router";

type LinkProps = {
  to: string;
  className?: string;
  current?: boolean;
  "aria-label"?: string;
  /** 先に呼ぶ。preventDefault したら移らない（今いるタブをもう一度押したとき。docs/specs/T-56-motion.md「M-07」） */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
};

/** アプリの中の移動。修飾キー付きのクリックはブラウザに任せる */
export function Link({ to, className, current, children, onClick: before, ...rest }: LinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    before?.(e);
    if (e.defaultPrevented) return;
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
