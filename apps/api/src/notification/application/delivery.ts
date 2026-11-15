import type { AppDeps, Bindings } from "../../env";
import {
  activeSessionIds,
  getNotificationAddress,
  getUserTimezone,
  hasEarlierSession,
} from "../../identity/application/auth";
import { broadcastOwnerOf, inviteActorOf } from "../../invitation/application/calendarFacing";
import { decryptSecret } from "../../shared/crypto";
import { localDay } from "../domain/day";
import { draftsFor, type Lookups } from "../domain/events";
import { CATEGORY_OF, countsTowardDailyLimit, EMAIL_DAILY_LIMIT, PUSH_DAILY_LIMIT } from "../domain/kinds";
import { mailFor } from "../domain/mail";
import { sendPush } from "../infra/push";
import * as repo from "../infra/repository";
import { sendMail } from "../infra/resend";
import { pushAad } from "./subscriptions";

// お知らせを作って届ける（docs/specs/T-07-notification.md「振る舞い」）
// ログには、お知らせの種類・送り先の種類・結果・状態コードだけを出す

type Ctx = { env: Bindings; deps: AppDeps };

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/** T-07 を有効にした時刻。これより前のイベントではお知らせを作らない */
export const notificationStartAt = (env: Bindings) => Number(env.NOTIFICATION_START_AT) || 0;

/**
 * イベントからお知らせを作り、受け取り手ごとに届けるメッセージを Queue に分ける。
 * 同じイベントが2回届いても、お知らせは1件。届け終えていないものだけを送り直す
 */
export async function createFromEvent(ctx: Ctx, event: { id: string; type: string; payload: Record<string, unknown> }) {
  const occurredAt = Date.parse(str(event.payload.occurredAt) ?? "");
  const createdAt = Number.isFinite(occurredAt) ? occurredAt : ctx.deps.now();
  if (createdAt < notificationStartAt(ctx.env)) return 0;

  const lookups: Lookups = {};
  const userId = str(event.payload.userId);
  if (event.type === "BroadcastDecided") {
    const id = str(event.payload.broadcastId);
    lookups.broadcastOwner = id ? await broadcastOwnerOf(ctx, id) : null;
  } else if (event.type === "MeetupConfirmed") {
    const id = str(event.payload.inviteId);
    lookups.inviteActor = id ? await inviteActorOf(ctx, id) : null;
  } else if (event.type === "SessionStarted") {
    const sessionId = str(event.payload.sessionId);
    lookups.hasEarlierSession = userId && sessionId ? await hasEarlierSession(ctx.env, userId, sessionId) : false;
  }

  const drafts = draftsFor(event.type, event.payload, lookups);
  const pending = await repo.insertDrafts(ctx.env.DB, event.id, drafts, createdAt, ctx.deps.now());
  for (let i = 0; i < pending.length; i += 100) {
    await ctx.env.JOBS.sendBatch(
      pending.slice(i, i + 100).map((id) => ({ body: { kind: "notification_deliver" as const, notificationId: id } })),
    );
  }
  return pending.length;
}

type SendOutcome = "sent" | "none_usable";

/** 使える購読すべてに送る。1つでも送れたら sent。1つも使えなければ none_usable。一時的な失敗は投げる */
async function pushToAll(ctx: Ctx, userId: string, kind: string): Promise<SendOutcome> {
  const now = ctx.deps.now();
  const subscriptions = await repo.subscriptionsOf(ctx.env.DB, userId);
  const active = await activeSessionIds(
    ctx.env,
    subscriptions.map((s) => s.session_id),
    now,
  );
  let sent = false;
  for (const sub of subscriptions) {
    // 失効・期限切れのセッションの購読には送らず、消す
    if (!active.has(sub.session_id)) {
      await repo.deleteSubscriptionById(ctx.env.DB, sub.id);
      continue;
    }
    let endpoint: string;
    try {
      endpoint = await decryptSecret(sub.endpoint_enc, ctx.env.NOTIFICATION_KEYS, pushAad(userId));
    } catch {
      log("notification_push_skipped", { kind, reason: "decrypt" });
      continue;
    }
    const result = await sendPush(ctx.env, ctx.deps, endpoint);
    if (result === "sent") {
      sent = true;
      await repo.markSubscriptionSuccess(ctx.env.DB, sub.id, now);
    } else if (result === "gone") {
      await repo.deleteSubscriptionById(ctx.env.DB, sub.id);
    } else {
      log("notification_push_rejected", { kind });
    }
  }
  return sent ? "sent" : "none_usable";
}

/** メールで送る。上限・宛先がなければ、送らずに理由を返す。一時的な失敗は投げる */
async function sendByEmail(ctx: Ctx, n: repo.NotificationRow, day: string, timezone: string): Promise<repo.Outcome> {
  const to = await getNotificationAddress(ctx.env, n.user_id);
  if (!to) return "no_address";
  const now = ctx.deps.now();
  if (
    countsTowardDailyLimit(n.kind) &&
    !(await repo.countWithinLimit(ctx.env.DB, { id: n.id, userId: n.user_id }, "email", day, EMAIL_DAILY_LIMIT, now))
  ) {
    return "limited";
  }
  // サービス全体の1日のメール数。超えていても、新しい端末でのログインだけは送る（安全の通知を優先）
  const globalLimit = Number(ctx.env.MAIL_DAILY_LIMIT) || 0;
  const withinGlobal = await repo.claimGlobalEmailCount(ctx.env.DB, n.id, day, globalLimit);
  if (!withinGlobal && n.kind !== "new_login") return "limited";

  const mail = mailFor({ kind: n.kind, device: n.device, createdAt: n.created_at }, { origin: ctx.env.APP_ORIGIN, timezone });
  const result = await sendMail(ctx.env, ctx.deps, { to, mail, idempotencyKey: n.id });
  return result === "sent" ? "sent" : "failed";
}

/** 1件を届ける。二重に届いても、届け終えていれば何もしない */
export async function deliver(ctx: Ctx, notificationId: string) {
  const n = await repo.findNotification(ctx.env.DB, notificationId);
  if (!n || n.delivered_at !== null) return;
  const now = ctx.deps.now();
  const done = async (channel: repo.Channel | "none", outcome: repo.Outcome) => {
    await repo.markDelivered(ctx.env.DB, n.id, channel, outcome, ctx.deps.now());
    log("notification_delivered", { kind: n.kind, channel, outcome });
  };

  // 止めた種別は送らない（一覧には残る）。新しい端末でのログインは止められない
  const category = CATEGORY_OF[n.kind];
  if (category) {
    const prefs = await repo.getPreferences(ctx.env.DB, n.user_id);
    if (prefs && prefs[category] === 0) return done("none", "muted");
  }

  const timezone = await getUserTimezone(ctx.env, n.user_id);
  const day = localDay(now, timezone);

  // 新しい端末でのログインはメールだけ。ほかは、購読があればプッシュ、なければメール
  if (n.kind !== "new_login" && (await repo.hasSubscription(ctx.env.DB, n.user_id))) {
    if (
      countsTowardDailyLimit(n.kind) &&
      !(await repo.countWithinLimit(ctx.env.DB, { id: n.id, userId: n.user_id }, "push", day, PUSH_DAILY_LIMIT, now))
    ) {
      return done("push", "limited");
    }
    if ((await pushToAll(ctx, n.user_id, n.kind)) === "sent") return done("push", "sent");
    // 使える購読が1つもなかった：同じお知らせをメールに切り替える
  }
  return done("email", await sendByEmail(ctx, n, day, timezone));
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const NOTIFICATION_RETENTION_MS = 90 * DAY_MS;

/** 90日を過ぎたお知らせと、2日より前の日ごとの数を消す */
export async function cleanupNotifications(ctx: Ctx) {
  const now = ctx.deps.now();
  await repo.deleteOldNotifications(ctx.env.DB, now - NOTIFICATION_RETENTION_MS);
  // どのタイムゾーンの「今日」「昨日」も消さないよう、UTC で3日前より前の日付を消す
  await repo.deleteOldCounts(ctx.env.DB, new Date(now - 3 * DAY_MS).toISOString().slice(0, 10));
}
