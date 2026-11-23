import { meResponseSchema } from "@kokohima/shared";
import { apiGet } from "../api/client";
import { keys } from "../api/keys";

// 自分のプロフィールと相手の表示名。どの画面からも使うので、ページの間で取り込み合わないようにここに置く

export const displayNameOf = (name: string | null) => name ?? "名前未設定の友達";

/** 退会した人（docs/specs/T-16-withdrawal.md）。「名前未設定の友達」とは区別する */
export const WITHDRAWN_USER = "退会したユーザー";

type Named = { displayName: string | null; withdrawn?: boolean };

/** 履歴の相手の名前。退会した人は「退会したユーザー」 */
export const nameOfProfile = (p: Named) => (p.withdrawn ? WITHDRAWN_USER : displayNameOf(p.displayName));

/** 「〇〇さん」。退会した人には「さん」を付けない */
export const honorificOf = (p: Named) => (p.withdrawn ? WITHDRAWN_USER : `${displayNameOf(p.displayName)}さん`);

export const meQuery = () => ({ queryKey: keys.me(), queryFn: () => apiGet("/api/v1/me", meResponseSchema) });

/**
 * 名前の画面の判定に使う GET /me（docs/specs/T-31-display-name-first-step.md）。
 * 読み込めないときに長く読み込み中で止めないよう、読み直しは1回まで。オフラインでも一時停止せずに失敗として扱う
 */
export const meGateQuery = () => ({ ...meQuery(), retry: 1, retryDelay: 300, networkMode: "always" as const });
