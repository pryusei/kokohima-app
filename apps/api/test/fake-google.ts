// カレンダー連携のテスト用の偽の Google（本番のコードからは読み込まない）
// 受けたリクエストをすべて記録し、テストから「呼んでよい経路だけを呼んだか」を確かめられるようにする

type Busy = { start: string; end: string };
type StoredEvent = { calendarId: string; id: string; status: "confirmed" | "cancelled"; body: Record<string, unknown> };

export type GoogleRequest = { method: string; url: string; path: string; body: string };

export function createFakeGoogle() {
  const state = {
    /** 次の認可コードの交換が返すスコープ */
    grantedScopes: [
      "https://www.googleapis.com/auth/calendar.freebusy",
      "https://www.googleapis.com/auth/calendar.app.created",
    ],
    /** 失効させた更新用トークン（invalid_grant を返す） */
    revoked: new Set<string>(),
    refreshCounter: 0,
    busy: [] as Busy[],
    /** freeBusy の応答を差し替える（エラー付きの200など） */
    freeBusyOverride: null as null | (() => Response),
    calendars: new Map<string, { summary: string; timeZone: string }>(),
    events: new Map<string, StoredEvent>(),
    calendarCounter: 0,
    /** 次の応答を失敗させる経路（例："POST /calendars/x/events"）→ ステータス */
    failNext: new Map<string, number>(),
    /** 予定の書き込みを上限以外の理由の403で断り続ける（Workspace の管理者の制限など） */
    forbidEventWrites: false,
    requests: [] as GoogleRequest[],
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const eventKey = (calendarId: string, id: string) => `${calendarId}/${id}`;

  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    const path = url.pathname;
    state.requests.push({ method, url: url.toString(), path, body });
    const failKey = `${method} ${path}`;
    const failStatus = state.failNext.get(failKey);
    if (failStatus !== undefined) {
      state.failNext.delete(failKey);
      return json({ error: { errors: [{ reason: "backendError" }] } }, failStatus);
    }

    if (url.host === "oauth2.googleapis.com" && path === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        const n = ++state.refreshCounter;
        return json({
          access_token: `access-${n}`,
          refresh_token: `refresh-${n}`,
          scope: state.grantedScopes.join(" "),
          token_type: "Bearer",
        });
      }
      const refresh = form.get("refresh_token") ?? "";
      if (state.revoked.has(refresh)) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: `access-for-${refresh}`, token_type: "Bearer" });
    }
    if (url.host === "oauth2.googleapis.com" && path === "/revoke") {
      const token = new URLSearchParams(body).get("token") ?? "";
      state.revoked.add(token);
      return new Response(null, { status: 200 });
    }

    if (url.host !== "www.googleapis.com" || !path.startsWith("/calendar/v3")) return json({}, 404);
    const sub = path.slice("/calendar/v3".length);

    if (sub === "/freeBusy" && method === "POST") {
      if (state.freeBusyOverride) return state.freeBusyOverride();
      const req = JSON.parse(body) as { timeMin: string; timeMax: string };
      const from = Date.parse(req.timeMin);
      const to = Date.parse(req.timeMax);
      const busy = state.busy.filter((b) => Date.parse(b.end) > from && Date.parse(b.start) < to);
      return json({ kind: "calendar#freeBusy", calendars: { primary: { busy } } });
    }
    if (sub === "/calendars" && method === "POST") {
      const req = JSON.parse(body) as { summary: string; timeZone: string };
      const id = `cal-${++state.calendarCounter}@group.calendar.google.com`;
      state.calendars.set(id, req);
      return json({ id, summary: req.summary });
    }
    const calMatch = /^\/calendars\/([^/]+)(\/events(?:\/([^/]+))?)?$/.exec(sub);
    if (!calMatch) return json({}, 404);
    const calendarId = decodeURIComponent(calMatch[1] ?? "");
    if (!calMatch[2]) {
      if (method === "DELETE") {
        state.calendars.delete(calendarId);
        return new Response(null, { status: 204 });
      }
      return json({}, 404);
    }
    if (!state.calendars.has(calendarId)) return json({ error: { errors: [{ reason: "notFound" }] } }, 404);
    const eventId = calMatch[3] ? decodeURIComponent(calMatch[3]) : null;
    if (state.forbidEventWrites && (method === "POST" || method === "PUT")) {
      return json({ error: { errors: [{ reason: "forbiddenForNonOrganizer" }] } }, 403);
    }
    if (method === "POST" && !eventId) {
      const req = JSON.parse(body) as Record<string, unknown> & { id: string };
      const existing = state.events.get(eventKey(calendarId, req.id));
      if (existing) return json({ error: { errors: [{ reason: "duplicate" }] } }, 409);
      state.events.set(eventKey(calendarId, req.id), { calendarId, id: req.id, status: "confirmed", body: req });
      return json({ id: req.id });
    }
    if (method === "PUT" && eventId) {
      const existing = state.events.get(eventKey(calendarId, eventId));
      if (!existing) return json({}, 404);
      const req = JSON.parse(body) as Record<string, unknown>;
      state.events.set(eventKey(calendarId, eventId), { calendarId, id: eventId, status: "confirmed", body: req });
      return json({ id: eventId });
    }
    if (method === "DELETE" && eventId) {
      const existing = state.events.get(eventKey(calendarId, eventId));
      if (!existing || existing.status === "cancelled") return json({}, 410);
      existing.status = "cancelled";
      return new Response(null, { status: 204 });
    }
    return json({}, 404);
  }

  return {
    state,
    /** この URL を偽の Google が受けるか（ログインのトークン交換は受けない） */
    handles(url: URL, init: RequestInit | undefined) {
      if (url.host === "www.googleapis.com" && url.pathname.startsWith("/calendar/v3")) return true;
      if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") return true;
      if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
        const form = new URLSearchParams(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
        return form.get("grant_type") === "refresh_token" || (form.get("redirect_uri") ?? "").includes("/calendar/");
      }
      return false;
    },
    handle,
    /** 生きている（キャンセルされていない）予定 */
    liveEvents() {
      return [...state.events.values()].filter((e) => e.status === "confirmed");
    },
  };
}

export type FakeGoogle = ReturnType<typeof createFakeGoogle>;
