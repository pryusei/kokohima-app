import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";

// Cookie（docs/specs/T-01-auth.md）。どちらも __Host- 接頭辞（Secure、Path=/、Domainなし）

const REFRESH = "kh_rt";
const BINDING = "kh_oauth";

export function getRefreshCookie(c: Context<AppEnv>) {
  return getCookie(c, REFRESH, "host");
}

export function setRefreshCookie(c: Context<AppEnv>, value: string, expiresAt: number) {
  setCookie(c, REFRESH, value, {
    prefix: "host",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    maxAge: Math.max(0, Math.floor((expiresAt - c.var.deps.now()) / 1000)),
  });
}

export function clearRefreshCookie(c: Context<AppEnv>) {
  deleteCookie(c, REFRESH, { prefix: "host", path: "/", secure: true });
}

export function getBindingCookie(c: Context<AppEnv>) {
  return getCookie(c, BINDING, "host");
}

/** Apple は form_post（クロスサイトのPOST）で戻るため SameSite=None、Google は Lax */
export function setBindingCookie(c: Context<AppEnv>, value: string, provider: "google" | "apple") {
  setCookie(c, BINDING, value, {
    prefix: "host",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: provider === "apple" ? "None" : "Lax",
    maxAge: 600,
  });
}

export function clearBindingCookie(c: Context<AppEnv>) {
  deleteCookie(c, BINDING, { prefix: "host", path: "/", secure: true });
}
