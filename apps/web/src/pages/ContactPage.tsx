import { CONTACT_BODY_MAX, CONTACT_CATEGORIES, CONTACT_CATEGORY_LABELS, contactBodyLength, type ContactCategory } from "@kokohima/shared";
import { useState } from "react";
import { ApiError } from "../api/client";
import { useSendContact } from "../contact/useSendContact";
import { ButtonLink, SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { CharCount, Chip, ChipRow, Field, textareaClass } from "../ui/form";
import { Link } from "../ui/Link";
import { SubScreen } from "../ui/Navigation";
import { useOnline } from "../ui/online";

// 問い合わせ（docs/specs/T-24-contact.md「9.」）。キャンバスに画面はないので、トークンと ui の部品だけで作る。
// 設定のトップの「このアプリについて」から開く。成功も失敗も静かに出す（赤・エラー色・Toast は使わない）。
// 書きかけの内容はブラウザのストレージに残さない（画面を離れたら消える）

/** 送れなかったときの文言。401 は API クライアントのまま（文言を足さない） */
function failureText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return "送れませんでした。もう一度お試しください。";
  if (error.status === 401) return null;
  if (error.status === 429) return "今日はこれ以上送れません。時間をおいて、もう一度お試しください。";
  if (error.status === 400) return "送れませんでした。内容を確かめてください。";
  return "送れませんでした。もう一度お試しください。";
}

export function ContactPage() {
  const online = useOnline();
  const [category, setCategory] = useState<ContactCategory | null>(null);
  const [body, setBody] = useState("");
  const send = useSendContact();
  const length = contactBodyLength(body);
  const sendable = category !== null && length > 0 && length <= CONTACT_BODY_MAX && !send.isPending;
  const failure = send.isError ? failureText(send.error) : null;

  return (
    <SubScreen title="問い合わせ" back="/settings">
      <p>
        不具合・ご意見・個人情報の求めなどを、運営に送れます。返事が要るものは、ログインに使っているアカウントのメールアドレスにお送りします。LINEでログインしているときはメールアドレスがないので、返事が要るものは、返信先のメールアドレスを内容に書いてください。
      </p>
      {send.isSuccess ? (
        <div role="status" className="flex flex-col gap-3 rounded-l bg-surface p-4 shadow-card">
          <h2 className="text-l font-bold">送りました</h2>
          <p>受け付けました。返事が要るものは、メールでお返しします。</p>
          <ButtonLink to="/settings" variant="ghost">
            設定に戻る
          </ButtonLink>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4 rounded-l bg-surface p-4 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (category !== null && sendable) send.mutate({ category, body });
          }}
        >
          <ChipRow label="種類">
            {CONTACT_CATEGORIES.map((c) => (
              <Chip key={c} selected={category === c} onClick={() => setCategory(c)}>
                {CONTACT_CATEGORY_LABELS[c]}
              </Chip>
            ))}
          </ChipRow>
          {category === "privacy_request" && (
            <Note>
              本人の確認のため、返事はログインに使っているアカウントのメールアドレスにだけお送りします（LINEでログインしているときは、この画面から送った求めに書いたメールアドレスにお送りします）。運営に届く前に退会すると、この求めは届きません。アカウントとデータをすべて消すときは、設定の『アカウント』から退会もできます。
            </Note>
          )}
          <div className="flex flex-col gap-1">
            <Field label="内容">
              <textarea className={textareaClass} rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <CharCount count={length} max={CONTACT_BODY_MAX} />
          </div>
          <Note>
            送った内容は、運営の連絡用の Slack（米国の Slack 社のサービス）に届きます。パスワードや、ほかの人の個人情報は書かないでください。くわしくは
            <Link to="/privacy" className="text-action underline">
              プライバシー ポリシー
            </Link>
          </Note>
          {failure && (
            <p role="status" className="text-ink-muted">
              {failure}
            </p>
          )}
          <SendButton type="submit" variant="primary" block disabled={!sendable}>
            送る
          </SendButton>
          {!online && <Note>オフラインの間は送れません</Note>}
        </form>
      )}
    </SubScreen>
  );
}
