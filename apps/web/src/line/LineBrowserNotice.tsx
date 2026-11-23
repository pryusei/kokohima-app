import { buttonClass } from "../ui/Button";

// LINEのアプリ内ブラウザ向けの案内の帯（docs/specs/T-28-line-share.md「LINEのアプリ内ブラウザ向けの案内の帯」）
// 静かな案内なので、赤やエラー色・警告の印を使わない

export function LineBrowserNotice({ reopenHref }: { reopenHref: string }) {
  return (
    <section aria-label="ブラウザで開き直す" className="flex flex-col gap-3 rounded-m bg-surface-sunken px-4 py-3">
      <p>LINEの中で開いています。Googleでログインできないことがあるので、ブラウザで開き直してください。</p>
      <a className={buttonClass("primary", { block: true })} href={reopenHref}>
        ブラウザで開き直す
      </a>
      <p className="text-s text-ink-muted">開き直せないときは、右上のメニューから［ブラウザで開く］を選んでください。</p>
    </section>
  );
}
