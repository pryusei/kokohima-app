import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";

// 招待Cookie（docs/specs/T-02-friends.md「招待リンクの受け口」）。ログインをはさんでも招待のトークンを失わないため
// identity（logout で消す）と social（発行・使用）の両方から使うので、ここに置く

const INVITE = "kh_invite";

export function getInviteCookie(c: Context<AppEnv>) {
  return getCookie(c, INVITE, "host");
}

export function setInviteCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, INVITE, token, {
    prefix: "host",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 3600,
  });
}

export function clearInviteCookie(c: Context<AppEnv>) {
  deleteCookie(c, INVITE, { prefix: "host", path: "/", secure: true });
}
