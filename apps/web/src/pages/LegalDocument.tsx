import type { ReactNode } from "react";
import { Link } from "../ui/Link";
import { PublicSubScreen } from "../ui/Navigation";
import { CONTACT_EMAIL, EFFECTIVE_DATE_LINE, REVISION_DATE_LINE, REVISION_NOTICE_LINE, useDocumentTitle } from "./legal";

// プライバシー ポリシーと利用規約の画面の形（docs/specs/T-19-privacy-terms.md「2.」「3.」）。
// 本文は JSX のテキストで書く（HTML の文字列の差し込みや Markdown の変換は使わない）。表は使わない

/**
 * changes：「この改定で変わるところ」のそのページの箇条書き（legal.ts の PRIVACY_REVISION_CHANGES など）。
 * 予告の行（REVISION_NOTICE_LINE）があり、箇条書きもあるときだけ節を出す（決めたこと15・「8.」）
 */
export function LegalDocument({
  title,
  changes,
  children,
}: {
  title: string;
  changes: readonly string[] | null;
  children: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <PublicSubScreen title={title} back="/">
      <article className="flex flex-col gap-6 text-ink">
        <div className="flex flex-col text-s text-ink-muted">
          <p>{EFFECTIVE_DATE_LINE}</p>
          {REVISION_DATE_LINE && <p>{REVISION_DATE_LINE}</p>}
          {REVISION_NOTICE_LINE && <p>{REVISION_NOTICE_LINE}</p>}
        </div>
        {REVISION_NOTICE_LINE && changes && changes.length > 0 && (
          <Clause title="この改定で変わるところ">
            <Bullets>
              {changes.map((change, i) => (
                // 固定の箇条書きで並びが変わらないので、順番を key にする
                <li key={i}>{change}</li>
              ))}
            </Bullets>
          </Clause>
        )}
        {children}
      </article>
    </PublicSubScreen>
  );
}

export function Clause({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-l font-bold">{title}</h2>
      {children}
    </section>
  );
}

export function SubClause({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-bold">{title}</h3>
      {children}
    </section>
  );
}

export function Bullets({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1 pl-5">{children}</ul>;
}

export function Numbered({ children }: { children: ReactNode }) {
  return <ol className="flex list-decimal flex-col gap-1 pl-5">{children}</ol>;
}

export function Mail() {
  return (
    <a className="text-action underline" href={`mailto:${CONTACT_EMAIL}`}>
      {CONTACT_EMAIL}
    </a>
  );
}

export function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="text-action underline" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Internal({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-action underline">
      {children}
    </Link>
  );
}

/** ログインの画面・招待リンクの受け口の下の1行（決めたこと7）。consent が偽ならリンクだけを並べる */
export function LegalLinks({ consent }: { consent: boolean }) {
  const privacy = <Internal to="/privacy">プライバシー ポリシー</Internal>;
  const terms = <Internal to="/terms">利用規約</Internal>;
  return (
    <p className="text-s text-ink-muted">
      {consent ? (
        <>
          続けると{terms}と{privacy}に同意したことになります
        </>
      ) : (
        <>
          {terms}・{privacy}
        </>
      )}
    </p>
  );
}
