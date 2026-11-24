import { RETENTION, RETENTION_UNIT_MS } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import {
  activeSessionIds,
  getHistoryProfiles,
  getNotificationAddress,
  getUserTimezone,
  hasEarlierSession,
} from "../../identity/application/auth";
import { broadcastOwnerOf, inviteActorOf, slotStartOf } from "../../invitation/application/calendarFacing";
import { decryptSecret, fromBase64Url } from "../../shared/crypto";
import { localDay } from "../domain/day";
import { draftsFor, type Lookups } from "../domain/events";
import {
  CATEGORY_OF,
  globalEmailLimitFor,
  isQuietHours,
  limitsFor,
  parseMailDailyLimit,
  parseNotificationStartAt,
  SILENT_KINDS,
  type DailyLimits,
} from "../domain/kinds";
import { pushBodyFor, pushPayloadOf, SLOT_OF, type LockScreen, type PushActor } from "../domain/push-message";
import { mailFor } from "../domain/mail";
import { sendPush } from "../infra/push";
import * as repo from "../infra/repository";
import { sendMail } from "../infra/resend";
import { encryptWebPush, PADDED_LENGTH } from "../infra/webpush-encryption";
import { pushAad, pushKeysAad } from "./subscriptions";

// お知らせを作って届ける（docs/specs/T-07-notification.md「振る舞い」）
// ログには、お知らせの種類・送り先の種類・結果・状態コードだけを出す

type Ctx = { env: Bindings; deps: AppDeps };

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * T-07 を有効にした時刻。これより前のイベントではお知らせを作らない。
 * 未設定・不正な値なら null（お知らせを作らない。dispatch も通知だけの型を流さない）
 */
export const notificationStartAt = (env: Bindings) => parseNotificationStartAt(env.NOTIFICATION_START_AT);

/**
 * イベントからお知らせを作り、受け取り手ごとに届けるメッセージを Queue に分ける。
 * 同じイベントが2回届いても、お知らせは1件。届け終えていないものだけを送り直す
 */
export async function createFromEvent(
  ctx: Ctx,
  event: { id: string; type: string; payload: Record<string, unknown>; outboxCreatedAt?: number },
) {
  const occurredAt = Date.parse(str(event.payload.occurredAt) ?? "");
  const createdAt = Number.isFinite(occurredAt) ? occurredAt : ctx.deps.now();
  // 線は outbox の行を作った時刻で引く（Queue のメッセージにないときだけ occurredAt）
  const startAt = notificationStartAt(ctx.env);
  if (startAt === null || (event.outboxCreatedAt ?? createdAt) < startAt) return 0;

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

const utf8 = new TextEncoder();

/**
 * プッシュの中身（暗号化する前のバイト列。T-35）。detailed なら相手の名前と開始の日時を読み、入れる。
 * 相手は受け取り手を閲覧者として読む（お知らせ一覧と同じ getHistoryProfiles）。日時は受け取り手のタイムゾーン。
 * 詰め物の長さに入らなければ、種類だけの文にする。文のない種類なら null（本文なしで送る）
 */
async function pushPlaintext(ctx: Ctx, n: repo.NotificationRow, mode: LockScreen, timezone: string) {
  let actor: PushActor | null = null;
  let startsAt: number | null = null;
  if (mode === "detailed") {
    if (n.actor_id) actor = (await getHistoryProfiles(ctx, n.user_id, [n.actor_id])).get(n.actor_id) ?? null;
    const slot = SLOT_OF[n.kind];
    if (slot && n.subject_id) startsAt = await slotStartOf(ctx, { type: slot, id: n.subject_id });
  }
  const encode = (m: LockScreen) => {
    const body = pushBodyFor({ kind: n.kind, count: n.count, actor, startsAt }, m, timezone);
    return body === null ? null : utf8.encode(pushPayloadOf(n.id, body));
  };
  const full = encode(mode);
  // 区切りの1バイトを足しても詰め物の長さに入るか
  if (full && full.byteLength + 1 <= PADDED_LENGTH) return full;
  return encode("hidden");
}

/** 購読の鍵を読み、中身を暗号化する。鍵がない・読めないときは null（本文なしで送る） */
async function encryptFor(ctx: Ctx, sub: repo.SubscriptionRow, plaintext: Uint8Array | null, kind: string) {
  if (!plaintext || !sub.keys_enc) return null;
  try {
    const raw = JSON.parse(await decryptSecret(sub.keys_enc, ctx.env.NOTIFICATION_KEYS, pushKeysAad(sub.user_id))) as {
      p256dh: string;
      auth: string;
    };
    return await encryptWebPush(plaintext, { p256dh: fromBase64Url(raw.p256dh), auth: fromBase64Url(raw.auth) });
  } catch {
    log("notification_push_plain", { kind, reason: "keys" });
    return null;
  }
}

/** 使える購読すべてに送る。1つでも送れたら sent。1つも使えなければ none_usable。一時的な失敗は投げる */
async function pushToAll(ctx: Ctx, userId: string, kind: string, plaintext: Uint8Array | null): Promise<SendOutcome> {
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
    // 購読ごとに鍵が違うので、購読ごとに暗号化する（送るたびに一時的な鍵と salt も変わる）
    const result = await sendPush(ctx.env, ctx.deps, endpoint, await encryptFor(ctx, sub, plaintext, kind));
    if (result.outcome === "sent") {
      sent = true;
      await repo.markSubscriptionSuccess(ctx.env.DB, sub.id, now);
    } else if (result.outcome === "gone") {
      await repo.deleteSubscriptionById(ctx.env.DB, sub.id);
    } else {
      log("notification_push_rejected", { kind, status: result.status });
    }
  }
  return sent ? "sent" : "none_usable";
}

/** メールで送る。上限・宛先がなければ、送らずに理由を返す。一時的な失敗は投げる */
async function sendByEmail(
  ctx: Ctx,
  n: repo.NotificationRow,
  limits: DailyLimits,
  day: string,
  timezone: string,
): Promise<repo.Outcome> {
  const to = await getNotificationAddress(ctx.env, n.user_id);
  if (!to) return "no_address";
  const now = ctx.deps.now();
  const user = { id: n.id, userId: n.user_id };
  if (!(await repo.countWithinLimit(ctx.env.DB, user, "email", limits.email.counter, day, limits.email.limit, now))) {
    return "limited";
  }
  // サービス全体の1日のメール数（UTC の日付）。組ごとに使える上限が違い、新端末のログインは超えていても送る
  const globalLimit = globalEmailLimitFor(limits.tier, parseMailDailyLimit(ctx.env.MAIL_DAILY_LIMIT));
  const utcDay = new Date(now).toISOString().slice(0, 10);
  if (!(await repo.claimGlobalEmailCount(ctx.env.DB, n.id, utcDay, globalLimit))) {
    // サービス全体の上限で送らなかった。種類だけを出す（宛先・利用者IDは出さない。docs/specs/T-13-monitoring.md「3.」）
    log("notification_mail_global_limit", { kind: n.kind });
    return "limited";
  }

  const mail = mailFor({ kind: n.kind, device: n.device, createdAt: n.created_at }, { origin: ctx.env.APP_ORIGIN, timezone });
  const result = await sendMail(ctx.env, ctx.deps, { to, mail, idempotencyKey: n.id });
  if (result.outcome === "sent") return "sent";
  log("notification_mail_rejected", { kind: n.kind, status: result.status });
  return "failed";
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

  // 断り・見送り・取り消し・抜けたは、どちらの見え方を選んでもプッシュもメールも送らない（一覧には残る。T-35）
  if (SILENT_KINDS.has(n.kind)) return done("none", "silent");

  // 止めた種別は送らない（一覧には残る）。新しい端末でのログインは止められない
  const category = CATEGORY_OF[n.kind];
  const prefs = category ? await repo.getPreferences(ctx.env.DB, n.user_id) : null;
  if (category && prefs && prefs[category] === 0) return done("none", "muted");

  const timezone = await getUserTimezone(ctx.env, n.user_id);
  const day = localDay(now, timezone);
  const limits = limitsFor(n.kind);

  // 新しい端末でのログインはメールだけ。ほかは、購読があればプッシュ、なければメール
  if (limits.push && (await repo.hasSubscription(ctx.env.DB, n.user_id))) {
    // 夜（日本時間の22時〜7時）は鳴らさない。メールにも切り替えず、お知らせ一覧にだけ残す（T-35）
    if (ctx.deps.notification.quietHours && isQuietHours(now)) return done("none", "night");
    const user = { id: n.id, userId: n.user_id };
    if (!(await repo.countWithinLimit(ctx.env.DB, user, "push", limits.push.counter, day, limits.push.limit, now))) {
      return done("push", "limited");
    }
    const mode: LockScreen = prefs?.lock_screen === "detailed" ? "detailed" : "hidden";
    const plaintext = await pushPlaintext(ctx, n, mode, timezone);
    if ((await pushToAll(ctx, n.user_id, n.kind, plaintext)) === "sent") return done("push", "sent");
    // 使える購読が1つもなかった：同じお知らせをメールに切り替える
  }
  return done("email", await sendByEmail(ctx, n, limits, day, timezone));
}

const DAY_MS = RETENTION_UNIT_MS.day;
/** お知らせを残す期間（作ってから30日。ちょうど30日の行は残す。docs/specs/T-17-retention.md「3.」） */
export const NOTIFICATION_RETENTION_MS = RETENTION.notificationsDays * DAY_MS;
/** 1回の掃除で消すお知らせの数の上限 */
export const NOTIFICATION_CLEANUP_BATCH = 1000;

/** 30日を過ぎたお知らせ（上限つき）と、2日より前の日ごとの数を消す。消したお知らせの数 */
export async function cleanupNotifications(ctx: Ctx) {
  const now = ctx.deps.now();
  const deleted = await repo.deleteOldNotifications(ctx.env.DB, now - NOTIFICATION_RETENTION_MS, NOTIFICATION_CLEANUP_BATCH);
  // どのタイムゾーンの「今日」「昨日」も消さないよう、UTC で3日前より前の日付を消す
  await repo.deleteOldCounts(ctx.env.DB, countsCutoffDay(now));
  return deleted;
}

/** 日ごとの数は、日付が UTC の今日の3日前の日付より前なら消す */
export const countsCutoffDay = (now: number) =>
  new Date(now - RETENTION.notificationDailyCountsDaysBefore * DAY_MS).toISOString().slice(0, 10);
