import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "./Link";
import { useOnline } from "./online";

// ボタン（デザインシステム「Button」）。主＝action、灯り＝lamp（ここ暇を作る・募るだけ）、副＝枠つき、文字だけ＝ghost

export type ButtonVariant = "primary" | "lamp" | "secondary" | "ghost";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-m border px-4 font-bold transition-transform active:scale-[.98] disabled:cursor-default disabled:border-line disabled:bg-surface-sunken disabled:text-ink-disabled disabled:active:scale-100";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-action text-on-action hover:bg-action-hover",
  lamp: "border-transparent bg-lamp text-on-lamp",
  secondary: "border-line-strong bg-surface text-ink",
  ghost: "border-transparent bg-transparent text-ink",
};

const SIZE = { m: "min-h-11", s: "min-h-9 px-3 text-s" } as const;

export function buttonClass(variant: ButtonVariant = "secondary", { block = false, size = "m" as keyof typeof SIZE } = {}) {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]}${block ? " w-full" : ""}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  block?: boolean;
  size?: keyof typeof SIZE;
};

export function Button({ variant = "secondary", block, size, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={`${buttonClass(variant, { block, size })} ${className ?? ""}`} {...rest} />;
}

/** 送る操作のボタン。オフラインの間は押せなくする（docs/specs/T-11-design.md「オフライン」） */
export function SendButton({ disabled, ...rest }: ButtonProps) {
  const online = useOnline();
  return <Button disabled={disabled || !online} {...rest} />;
}

type ButtonLinkProps = { to: string; variant?: ButtonVariant; block?: boolean; size?: keyof typeof SIZE; children: ReactNode };

/** ボタンの見た目のアプリ内リンク */
export function ButtonLink({ to, variant = "secondary", block, size, children }: ButtonLinkProps) {
  return (
    <Link to={to} className={`${buttonClass(variant, { block, size })} no-underline`}>
      {children}
    </Link>
  );
}
