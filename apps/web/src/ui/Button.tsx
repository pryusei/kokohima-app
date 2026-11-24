import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import { Link } from "./Link";
import { useOnline } from "./online";

// ボタン（デザインシステム「Button」）。主＝action、灯り＝lamp（ここ暇を作る・募るだけ）、副＝枠つき、文字だけ＝ghost、
// ログインの事業者の決まりの色＝line・apple、保存・送信できた直後＝saved（SaveButton・SubmitButton だけが使う。T-54・T-56 M-03）、
// 成立した予定へ進む＝meet（T-56 M-04）（docs/specs/T-11-design.md「共通の部品」）。
// 色は1つの variant の中だけで決める。Tailwind v4 は同じ性質のクラスをクラス名の順に出すので、
// buttonClass() のあとに bg-・text-・border- を足しても上書きにならない（後ろに書いたほうが勝つとは限らない）

export type ButtonVariant = "primary" | "lamp" | "secondary" | "ghost" | "line" | "apple" | "saved" | "meet";

// 押した縮みは、押せるときだけ（disabled・aria-disabled（送信中・「✓ 送りました」のあいだ）では縮まない）。
// 打ち消しのクラス（active:scale-100）を後ろに足しても、出力の順で負けることがあるので、条件のほうに書く
const BASE =
  "inline-flex items-center justify-center gap-2 rounded-m border px-4 font-bold transition-transform duration-(--duration-press) ease-out not-disabled:not-aria-disabled:active:scale-[.98] disabled:cursor-default";

// 押せないときの色。saved は押せないあいだも「✓」の色を見せたいので付けない
// （disabled: の色は地の色のクラスより後に出て必ず勝つので、saved の側からは上書きできない）
const DISABLED_COLORS = "disabled:border-line disabled:bg-surface-sunken disabled:text-ink-disabled";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-action text-on-action hover:bg-action-hover",
  lamp: "border-transparent bg-lamp text-on-lamp",
  secondary: "border-line-strong bg-surface text-ink",
  ghost: "border-transparent bg-transparent text-ink",
  line: "border-transparent bg-brand-line text-on-brand-line",
  apple: "border-transparent bg-ink text-surface",
  // 「✓ 保存しました」「✓ 送りました」は操作の青（成立の青緑は成立だけに使う）
  saved: "border-action bg-surface text-action",
  meet: "border-transparent bg-meet text-on-meet",
};

const SIZE = { m: "min-h-11", s: "min-h-9 px-3 text-s" } as const;

export function buttonClass(variant: ButtonVariant = "secondary", { block = false, size = "m" as keyof typeof SIZE } = {}) {
  const disabledColors = variant === "saved" ? "" : ` ${DISABLED_COLORS}`;
  return `${BASE}${disabledColors} ${VARIANT[variant]} ${SIZE[size]}${block ? " w-full" : ""}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  block?: boolean;
  size?: keyof typeof SIZE;
};

export function Button({ variant = "secondary", block, size, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={`${buttonClass(variant, { block, size })} ${className ?? ""}`} {...rest} />;
}

type SendButtonProps = ButtonProps & {
  /** 送信中。元の色のまま薄くし、押しても・Enter でフォームを送っても何もしない（docs/specs/T-56-motion.md「M-14」） */
  pending?: boolean;
};

/**
 * 送る操作のボタン。オフラインの間は押せなくする（docs/specs/T-11-design.md「オフライン」）。
 * 送信中は disabled にせず aria-disabled にする（フォーカスがボタンに残り、body に外れない）。灰色はオフラインと入力がそろっていないときだけ
 */
export function SendButton({ disabled, pending = false, className, onClick, ...rest }: SendButtonProps) {
  const online = useOnline();
  const ignore = (e: MouseEvent<HTMLButtonElement>) => {
    // 送信中の押下は、フォームの送信（Enter の暗黙の送信を含む）ごと止める
    if (pending) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <Button
      disabled={disabled || !online}
      aria-disabled={pending || undefined}
      data-pending={pending || undefined}
      className={`kh-send-motion ${pending ? "cursor-default opacity-70" : ""} ${className ?? ""}`}
      onClick={ignore}
      {...rest}
    />
  );
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
