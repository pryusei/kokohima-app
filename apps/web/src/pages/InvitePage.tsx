import { acceptInviteResponseSchema, inviteLookupResponseSchema, type InviteLookupResponse } from "@kokohima/shared";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { navigate } from "../router";

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
  | { kind: "own" }
  | { kind: "network" };

export function InvitePage() {
  const { status } = useAuth();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [sending, setSending] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readAndClearInviteToken();
    void (async () => {
      try {
        const res = await fetch("/api/v1/invite-links/lookup", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(token ? { token } : {}),
        });
        const parsed = inviteLookupResponseSchema.safeParse(res.ok ? await res.json() : null);
        setState(parsed.success ? { kind: "ready", invite: parsed.data } : { kind: "unusable" });
      } catch {
        setState({ kind: "network" });
      }
    })();
  }, []);

  const accept = async (linkId: string) => {
    setSending(true);
    try {
      const res = await apiFetch("/api/v1/invite-links/accept", { method: "POST", body: JSON.stringify({ linkId }) });
      acceptInviteResponseSchema.parse(await res.json());
      navigate("/friends", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setState({ kind: "own" });
      else if (err instanceof ApiError && err.status === 404) setState({ kind: "unusable" });
      // 通信エラー：成功していることもあるので再送せず、友達一覧で確かめてもらう
      else setState({ kind: "network" });
    } finally {
      setSending(false);
    }
  };

  const loginUrl = (provider: "google" | "apple") => `/api/v1/auth/${provider}/start?returnTo=${encodeURIComponent("/invite")}`;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">ここ暇</h1>
      {state.kind === "loading" && <p role="status">読み込み中…</p>}
      {state.kind === "unusable" && (
        <p role="status" className="text-slate-600">
          このリンクは使えません。発行した人に新しいリンクをもらってください。
        </p>
      )}
      {state.kind === "own" && (
        <p role="status" className="text-slate-600">
          これはあなたが作ったリンクです。友達に送ってください。
        </p>
      )}
      {state.kind === "network" && (
        <p role="status" className="text-slate-600">
          通信できませんでした。友達になれているか、<a className="underline" href="/friends">友達一覧</a>で確認してください。
        </p>
      )}
      {state.kind === "ready" && (
        <>
          <p>
            <span className="font-bold">{state.invite.inviter.displayName ?? "友達"}</span>
            さんから、ここ暇の友達の招待が届いています。
          </p>
          {status === "authenticated" ? (
            <button
              type="button"
              disabled={sending}
              className="rounded-lg bg-amber-300 px-4 py-3 disabled:opacity-50"
              onClick={() => void accept(state.invite.linkId)}
            >
              友達になる
            </button>
          ) : status === "checking" ? (
            <p role="status">読み込み中…</p>
          ) : (
            <>
              <p className="text-slate-600">友達になるには、ログインしてください。</p>
              <a className="rounded-lg border border-slate-300 bg-white px-4 py-3 text-center" href={loginUrl("google")}>
                Googleでログイン
              </a>
              <a className="rounded-lg bg-black px-4 py-3 text-center text-white" href={loginUrl("apple")}>
                Appleでログイン
              </a>
            </>
          )}
        </>
      )}
    </main>
  );
}
