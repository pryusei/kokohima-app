import type { AppDeps, Bindings } from "../../../env";
import type { Interval } from "../../domain/busy";
import {
  ProviderUnavailable,
  ReauthRequired,
  type CalendarEvent,
  type CalendarProvider,
  type GrantedTokens,
} from "../../domain/provider";

// Google カレンダーの実装（docs/specs/T-06-calendar.md「Googleのスコープ」）
// 呼ぶのはトークン・失効・freeBusy・カレンダーと予定の作成・更新・削除だけ。予定の一覧・取得、カレンダーの一覧は呼ばない
// 応答の本文はログにもエラーにも出さない

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;

const TIMEOUT_MS = 5000;
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]);

const iso = (ms: number) => new Date(ms).toISOString();

export function googleProvider(env: Bindings, deps: AppDeps): CalendarProvider {
  const endpoints = deps.google.endpoints;

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await deps.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ProviderUnavailable("unreachable");
    }
  }

  async function form(url: string, body: Record<string, string>) {
    return call(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body),
    });
  }

  const api = (accessToken: string, path: string, init: RequestInit = {}) =>
    call(`${endpoints.calendar}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });

  /** 403 のうち、上限によるもの（一時的な失敗）か */
  async function isRateLimited(res: Response) {
    const json: unknown = await res.json().catch(() => null);
    const errors = (json as { error?: { errors?: { reason?: unknown }[] } } | null)?.error?.errors ?? [];
    return errors.some((e) => typeof e.reason === "string" && RATE_LIMIT_REASONS.has(e.reason));
  }

  const calendarPath = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}`;

  return {
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL(endpoints.authorize);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier, redirectUri }): Promise<GrantedTokens> {
      const res = await form(endpoints.token, {
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      });
      if (!res.ok) throw new ProviderUnavailable("token_endpoint_error");
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const refreshToken = json?.refresh_token;
      const accessToken = json?.access_token;
      if (typeof refreshToken !== "string" || typeof accessToken !== "string") {
        throw new ProviderUnavailable("token_missing");
      }
      const scopes = typeof json?.scope === "string" ? json.scope.split(" ").filter(Boolean) : [];
      return { refreshToken, accessToken, scopes };
    },

    async accessToken(refreshToken) {
      const res = await form(endpoints.token, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 400 && json?.error === "invalid_grant") throw new ReauthRequired();
      if (!res.ok || typeof json?.access_token !== "string") throw new ProviderUnavailable("token_endpoint_error");
      return json.access_token;
    },

    async busy(accessToken, from, to): Promise<Interval[]> {
      const res = await api(accessToken, "/freeBusy", {
        method: "POST",
        body: JSON.stringify({ timeMin: iso(from), timeMax: iso(to), items: [{ id: "primary" }] }),
      });
      if (!res.ok) throw new ProviderUnavailable("freebusy_error");
      const json = (await res.json().catch(() => null)) as {
        calendars?: { primary?: { errors?: unknown[]; busy?: { start?: unknown; end?: unknown }[] } };
      } | null;
      const primary = json?.calendars?.primary;
      // エラー付きの200を「埋まりなし」と扱うと、次の確認で埋まりがすべて新しく見えてしまう
      if (!primary || (Array.isArray(primary.errors) && primary.errors.length > 0) || !Array.isArray(primary.busy)) {
        throw new ProviderUnavailable("freebusy_calendar_error");
      }
      return primary.busy.flatMap((b) => {
        const startsAt = typeof b.start === "string" ? Date.parse(b.start) : NaN;
        const endsAt = typeof b.end === "string" ? Date.parse(b.end) : NaN;
        return Number.isFinite(startsAt) && Number.isFinite(endsAt) ? [{ startsAt, endsAt }] : [];
      });
    },

    async createCalendar(accessToken, name, timezone) {
      const res = await api(accessToken, "/calendars", {
        method: "POST",
        body: JSON.stringify({ summary: name, timeZone: timezone }),
      });
      const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (!res.ok || typeof json?.id !== "string") throw new ProviderUnavailable("calendar_create_error");
      return json.id;
    },

    async deleteCalendar(accessToken, calendarId) {
      const res = await api(accessToken, calendarPath(calendarId), { method: "DELETE" });
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new ProviderUnavailable("calendar_delete_error");
    },

    async putEvent(accessToken, calendarId, event: CalendarEvent) {
      const body = {
        id: event.id,
        status: "confirmed",
        summary: event.title,
        location: event.location,
        description: event.description,
        start: { dateTime: iso(event.startsAt), timeZone: event.timezone },
        end: { dateTime: iso(event.endsAt), timeZone: event.timezone },
      };
      const created = await api(accessToken, `${calendarPath(calendarId)}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (created.ok) return "ok";
      if (created.status === 409) {
        // すでにある（削除済みも含む）。更新で中身をそろえ、status: confirmed に戻す
        const updated = await api(accessToken, `${calendarPath(calendarId)}/events/${encodeURIComponent(event.id)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        if (updated.ok) return "ok";
        if (updated.status === 404) return "calendar_missing";
        if (updated.status === 403 && !(await isRateLimited(updated))) return "calendar_missing";
        throw new ProviderUnavailable("event_update_error");
      }
      if (created.status === 404) return "calendar_missing";
      if (created.status === 403 && !(await isRateLimited(created))) return "calendar_missing";
      throw new ProviderUnavailable("event_create_error");
    },

    async deleteEvent(accessToken, calendarId, eventId) {
      const res = await api(accessToken, `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 404 || res.status === 410) return "ok";
      if (res.status === 403 && !(await isRateLimited(res))) return "calendar_missing";
      throw new ProviderUnavailable("event_delete_error");
    },

    async revoke(token) {
      try {
        await form(endpoints.revoke, { token });
      } catch {
        // 失効は試みるだけ（docs/specs/T-06-calendar.md「例外」）
      }
    },
  };
}
