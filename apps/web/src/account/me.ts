import { meResponseSchema } from "@kokohima/shared";
import { apiGet } from "../api/client";
import { keys } from "../api/keys";

// 自分のプロフィールと相手の表示名。どの画面からも使うので、ページの間で取り込み合わないようにここに置く

export const displayNameOf = (name: string | null) => name ?? "名前未設定の友達";

export const meQuery = () => ({ queryKey: keys.me(), queryFn: () => apiGet("/api/v1/me", meResponseSchema) });
