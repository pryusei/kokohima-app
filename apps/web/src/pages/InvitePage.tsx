import {
  acceptInviteResponseSchema,
  inviteLookupResponseSchema,
  meResponseSchema,
  type InviteLookupResponse,
  type MeResponse,
} from "@kokohima/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { meGateQuery } from "../account/me";
import { ApiError, apiFetch, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { useAuth } from "../auth/AuthProvider";
import { tokenStore } from "../auth/tokenStore";
import { isLineInAppBrowser, withOpenExternalBrowser } from "../line/line";
import { LineBrowserNotice } from "../line/LineBrowserNotice";
import { LoginButtons } from "../auth/LoginButtons";
import { navigate } from "../router";

import { Avatar } from "../ui/Avatar";
import { SendButton } from "../ui/Button";
import { Loading } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";
import { LegalLinks } from "./LegalDocument";

// 招待リンクの受け口（docs/specs/T-02-friends.md「招待リンクの受け口」）
// トークンはURLのフラグメントから読んだらすぐ消し、ブラウザのストレージには置かない（サーバーが招待Cookieで持ち越す）

export function readAndClearInviteToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return token;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; invite: InviteLookupResponse }
  | { kind: "unusable" }
  /** accept が404：使えないリンクか、別のタブで開いたリンクと違う。どちらにも当てはまる文言にする */
  | { kind: "acceptFailed" }
  | { kind: "own" }
  /** lookup で通信できなかった（まだ友達になっていない） */
  | { kind: "lookupNetwork" }
  /** lookup が回数の上限（429。T-10） */
  | { kind: "busy" }
  /** accept で通信できなかった（友達になれている可能性がある） */
  | { kind: "network" };

export function InvitePage() {
  const { status } = useAuth();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [sending, setSending] = useState(false);
  // LINEのアプリ内ブラウザから開き直すために、読んだトークンを画面のメモリにだけ持つ（ストレージに置かない。T-28）
  const [token, setToken] = useState<string | null>(null);
  const started = useRef(false);
  const read = useRef<{ token: string | null } | null>(null);

  // トークンは開いてすぐ URL から消す（ログインの確かめを待たない）
  useEffect(() => {
    if (read.current) return;
    read.current = { token: readAndClearInviteToken() };
    setToken(read.current.token);
  }, []);

  // lookup はログインの確かめが終わってから。ログインしていればアクセストークンを付け、
  // 発行者との間にブロックがあれば、使えないリンクと同じ表示にする（docs/specs/T-33-block-report.md「振る舞い 2.」）
  useEffect(() => {
    if (started.current || status === "checking" || !read.current) return;
    started.current = true;
    const token = read.current.token;
    const access = status === "authenticated" ? tokenStore.get() : null;
    void (async () => {
      try {
        const res = await fetch("/api/v1/invite-links/lookup", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...(access ? { Authorization: `Bearer ${access}` } : {}) },
          body: JSON.stringify(token ? { token } : {}),
        });
        if (res.status === 429) {
          setState({ kind: "busy" });
          return;
        }
        const parsed = inviteLookupResponseSchema.safeParse(res.ok ? await res.json() : null);
        setState(parsed.success ? { kind: "ready", invite: parsed.data } : { kind: "unusable" });
      } catch {
        setState({ kind: "lookupNetwork" });
      }
    })();
  }, [status]);

  const queryClient = useQueryClient();
  // 名前があるか（docs/specs/T-31-display-name-first-step.md「名前の画面（招待リンクの受け口）」）
  const me = useQuery({ ...meGateQuery(), enabled: status === "authenticated" && state.kind === "ready" });
  const [name, setName] = useState("");
  const [nameFailed, setNameFailed] = useState(false);

  /** 名前の保存（あれば）→ accept を、1回押すだけで続けて行う */
  const accept = async (linkId: string, displayName?: string) => {
    setSending(true);
    setNameFailed(false);
    let saved: MeResponse | undefined;
    if (displayName !== undefined) {
      try {
        saved = await apiSend("PATCH", "/api/v1/me", { displayName }, meResponseSchema);
      } catch {
        // 名前を保存できなければ accept を呼ばない
        setNameFailed(true);
        setSending(false);
        return;
      }
    }
    try {
      const res = await apiFetch("/api/v1/invite-links/accept", { method: "POST", body: JSON.stringify({ linkId }) });
      acceptInviteResponseSchema.parse(await res.json());
      // 新しい友達の一覧・行きたいを読み直す（T-22）
      void queryClient.invalidateQueries({ queryKey: keys.friends.all() });
      void queryClient.invalidateQueries({ queryKey: keys.wishes.all() });
      // 保存した名前は、移る前にキャッシュに入れる（移った先で名前の画面を出さない）
      if (saved) queryClient.setQueryData(keys.me(), saved);
      // 名前を決めて友達になった人には、直後の1画面を出す（T-31）
      navigate(saved ? "/welcome" : "/friends", { replace: true });
    } catch (err) {
      // 名前は保存されたまま（accept の結果によらない）
      if (saved) queryClient.setQueryData(keys.me(), saved);
      if (err instanceof ApiError && err.status === 409) setState({ kind: "own" });
      else if (err instanceof ApiError && err.status === 404) setState({ kind: "acceptFailed" });
      // 通信エラー：成功していることもあるので再送せず、友達一覧で確かめてもらう
      else setState({ kind: "network" });
    } finally {
      setSending(false);
    }
  };

  const canLogIn = state.kind === "ready" && status !== "authenticated" && status !== "checking";

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <h1 className="font-bold text-ink-muted">ここ暇</h1>
      {state.kind === "loading" && <Loading />}
      {state.kind === "unusable" && (
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          このリンクは使えません。発行した人に新しいリンクをもらってください。
        </p>
      )}
      {state.kind === "acceptFailed" && (
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          友達になれませんでした。招待リンクをもう一度開いてください。
        </p>
      )}
      {state.kind === "own" && (
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          これはあなたが作ったリンクです。友達に送ってください。
        </p>
      )}
      {state.kind === "busy" && (
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          混み合っています。少し待ってから、もう一度開いてください。
        </p>
      )}
      {state.kind === "lookupNetwork" && (
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          通信できませんでした。通信状態を確認して、リンクをもう一度開いてください。
        </p>
      )}
      {state.kind === "network" && (
        <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
          通信できませんでした。友達になれているか、<a className="text-action underline" href="/friends">友達一覧</a>で確認してください。
        </p>
      )}
      {state.kind === "ready" && (
        <>
          <div className="flex flex-col items-center gap-4 text-center">
            <Avatar name={state.invite.inviter.displayName} src={state.invite.inviter.avatarUrl} size="l" />
            <p className="text-xl font-bold">
              {state.invite.inviter.displayName ?? "友達"}さんから、ここ暇の友達の招待が届いています。
            </p>
            <p className="text-s text-ink-muted">友達になると、おたがいの「ここ暇」が見えて、気軽に誘えるようになります。</p>
          </div>
          {status === "authenticated" ? (
            me.isPending ? (
              <Loading />
            ) : me.isError ? (
              <p role="status" className="rounded-m bg-surface-sunken px-4 py-3">
                通信できませんでした。通信状態を確認して、リンクをもう一度開いてください。
              </p>
            ) : me.data.displayName === null ? (
              // 名前の入力を「友達になる」の確かめと兼ねる（T-31。T-02 決定事項8）。説明の文は足さない
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void accept(state.invite.linkId, name);
                }}
              >
                <Field label="あなたの表示名">
                  <input className={inputClass} value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
                </Field>
                <SendButton type="submit" variant="primary" block disabled={sending || name.trim() === ""}>
                  これで友達になる
                </SendButton>
                {nameFailed && (
                  <p role="status" className="text-s text-ink-muted">
                    保存できませんでした。1〜20文字で入力してください。
                  </p>
                )}
              </form>
            ) : (
              <SendButton variant="primary" block disabled={sending} onClick={() => void accept(state.invite.linkId)}>
                友達になる
              </SendButton>
            )
          ) : status === "checking" ? (
            <Loading />
          ) : (
            <>
              {/* トークンがあるときだけ（ないと、開き直した先で招待 Cookie がなく使えないリンクになる） */}
              {token && isLineInAppBrowser() && (
                <LineBrowserNotice reopenHref={withOpenExternalBrowser(`/invite#${new URLSearchParams({ t: token })}`)} />
              )}
              <p className="text-ink-muted">友達になるには、ログインしてください。</p>
              <LoginButtons returnTo="/invite" />
            </>
          )}
        </>
      )}
      {/*
        lookup が終わってから出す（トークンは招待 Cookie に移ってから。docs/specs/T-19-privacy-terms.md「4.」）。
        同意の1行は、ログインのボタンを出しているとき（使えるリンクで、未ログイン）だけ。ほかはリンクだけ
      */}
      {state.kind !== "loading" && <LegalLinks consent={canLogIn} />}
    </main>
  );
}
