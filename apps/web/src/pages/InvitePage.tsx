import { acceptInviteResponseSchema, inviteLookupResponseSchema, type InviteLookupResponse } from "@kokohima/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api/client";
import { keys } from "../api/keys";
import { useAuth } from "../auth/AuthProvider";
import { isLineInAppBrowser, withOpenExternalBrowser } from "../line/line";
import { LineBrowserNotice } from "../line/LineBrowserNotice";
import { navigate } from "../router";

import { Avatar } from "../ui/Avatar";
import { buttonClass, SendButton } from "../ui/Button";
import { Loading } from "../ui/feedback";
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

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readAndClearInviteToken();
    setToken(token);
    void (async () => {
      try {
        const res = await fetch("/api/v1/invite-links/lookup", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
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
  }, []);

  const queryClient = useQueryClient();
  const accept = async (linkId: string) => {
    setSending(true);
    try {
      const res = await apiFetch("/api/v1/invite-links/accept", { method: "POST", body: JSON.stringify({ linkId }) });
      acceptInviteResponseSchema.parse(await res.json());
      // 新しい友達の一覧・行きたいを読み直す（T-22）
      void queryClient.invalidateQueries({ queryKey: keys.friends.all() });
      void queryClient.invalidateQueries({ queryKey: keys.wishes.all() });
      navigate("/friends", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setState({ kind: "own" });
      else if (err instanceof ApiError && err.status === 404) setState({ kind: "acceptFailed" });
      // 通信エラー：成功していることもあるので再送せず、友達一覧で確かめてもらう
      else setState({ kind: "network" });
    } finally {
      setSending(false);
    }
  };

  const canLogIn = state.kind === "ready" && status !== "authenticated" && status !== "checking";
  const loginUrl = (provider: "google" | "apple") => `/api/v1/auth/${provider}/start?returnTo=${encodeURIComponent("/invite")}`;

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
            <SendButton variant="primary" block disabled={sending} onClick={() => void accept(state.invite.linkId)}>
              友達になる
            </SendButton>
          ) : status === "checking" ? (
            <Loading />
          ) : (
            <>
              {/* トークンがあるときだけ（ないと、開き直した先で招待 Cookie がなく使えないリンクになる） */}
              {token && isLineInAppBrowser() && (
                <LineBrowserNotice reopenHref={withOpenExternalBrowser(`/invite#${new URLSearchParams({ t: token })}`)} />
              )}
              <p className="text-ink-muted">友達になるには、ログインしてください。</p>
              <a className={buttonClass("secondary", { block: true })} href={loginUrl("google")}>
                Googleでログイン
              </a>
              {/* Sign in with Apple は VITE_APPLE_LOGIN_ENABLED が "1" のときだけ（T-12）。本番のビルドでは文字列ごと落ちる */}
              {import.meta.env.VITE_APPLE_LOGIN_ENABLED === "1" && (
                <a
                  data-provider="apple-login"
                  className={`${buttonClass("secondary", { block: true })} border-transparent bg-ink text-surface`}
                  href={loginUrl("apple")}
                >
                  Appleでログイン
                </a>
              )}
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
