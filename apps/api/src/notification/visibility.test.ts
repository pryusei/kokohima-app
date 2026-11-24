import { env } from "cloudflare:workers";
import { notificationPreferencesSchema } from "@kokohima/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { decryptWebPush, newBrowserKeys, type BrowserKeys } from "../../test/webpush-decrypt";
import { handleJob } from "../jobs/consumer";
import { ENCRYPTED_LENGTH } from "./infra/webpush-encryption";

// T-35 通知の見え方を本人が選ぶ（docs/specs/T-35-notification-visibility.md「テスト計画」）。
// 時計は 2026-10-10T00:00:00Z（土曜、東京は 09:00）。誘いの開始 2026-10-11T02:00Z は東京で 10月11日(日) 11:00

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
  await env.DB.prepare("DELETE FROM notification_daily_counts WHERE user_id = ''").run();
});

const T = (s: string, day = "11") => `2026-10-${day}T${s}:00.000Z`;
const HOUR = 60 * 60 * 1000;

async function person(name: string) {
  const who = await u.user(name);
  await env.DB.prepare("UPDATE users SET email = ?2 WHERE id = ?1").bind(who.id, `${who.id}@mail.test`).run();
  return who;
}
const mailsTo = (who: User) => h.delivery.state.mails.filter((m) => m.to.includes(`${who.id}@mail.test`));

async function drain() {
  while (h.jobs.length > 0) {
    const job = h.jobs.shift();
    if (job?.kind === "notification_deliver") await handleJob(h.ctx, job);
  }
}
async function flush(idPart: string, types?: string[]) {
  h.clock.now += 1;
  const { results } = await env.DB.prepare(
    "SELECT id, type, payload FROM outbox WHERE payload LIKE ?1 AND processed_at IS NULL ORDER BY created_at, rowid",
  )
    .bind(`%${idPart}%`)
    .all<{ id: string; type: string; payload: string }>();
  for (const r of results) {
    if (types && !types.includes(r.type)) continue;
    await handleJob(h.ctx, { kind: "outbox", id: r.id, type: r.type, payload: r.payload });
    await env.DB.prepare("UPDATE outbox SET processed_at = ?2 WHERE id = ?1").bind(r.id, h.clock.now).run();
  }
  await drain();
}

async function pair() {
  const a = await person("あき");
  const b = await person("べに");
  await u.befriend(a, b);
  await flush(a.id, ["FriendshipEstablished"]);
  h.delivery.state.mails.length = 0;
  h.delivery.state.pushes.length = 0;
  return { a, b };
}

const endpointFor = () => `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
async function subscribeWithKeys(who: User, endpoint = endpointFor()) {
  const keys = await newBrowserKeys();
  const res = await u.call("POST", "/api/v1/push/subscriptions", { token: who.token, body: { endpoint, keys: keys.json } });
  expect(res.status).toBe(204);
  return { endpoint, keys };
}

async function invite(from: User, to: User, startsAt = T("02:00"), endsAt = T("03:00")) {
  const res = await u.call("POST", "/api/v1/direct-invites", {
    token: from.token,
    body: { recipientId: to.id, startsAt, endsAt, message: "ひみつのひとこと", area: "しぶや", url: "https://example.com/x" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
const respond = (who: User, id: string, body: unknown) =>
  u.call("POST", `/api/v1/direct-invites/${id}/responses`, { token: who.token, body });
const setLockScreen = (who: User, lockScreen: "hidden" | "detailed") =>
  u.call("PATCH", "/api/v1/me/notification-preferences", { token: who.token, body: { lockScreen } });

const rowsOf = async (who: User) =>
  (
    await env.DB.prepare("SELECT kind, channel, outcome FROM notifications WHERE user_id = ?1 ORDER BY inserted_at, id")
      .bind(who.id)
      .all<{ kind: string; channel: string | null; outcome: string | null }>()
  ).results;

/** endpoint に届いたプッシュを復号して、Service Worker が受け取る中身にする */
async function pushesTo(endpoint: string, keys: BrowserKeys) {
  const pushes = h.delivery.state.pushes.filter((p) => p.url === endpoint);
  return Promise.all(
    pushes.map(async (p) => {
      expect(p.body?.byteLength).toBe(ENCRYPTED_LENGTH);
      expect(p.headers["content-encoding"]).toBe("aes128gcm");
      return JSON.parse(await decryptWebPush(p.body as Uint8Array, keys)) as { v: number; id: string; body: string };
    }),
  );
}

describe("ロック画面の見え方の設定", () => {
  it("初期値は「出さない」（hidden）。detailed に変えられ、他人の設定は変わらない。知らない値は400", async () => {
    const { a, b } = await pair();
    const get = async (who: User) =>
      notificationPreferencesSchema.parse(
        await (await u.call("GET", "/api/v1/me/notification-preferences", { token: who.token })).json(),
      );
    expect((await get(a)).lockScreen).toBe("hidden");
    const res = await setLockScreen(a, "detailed");
    expect(res.status).toBe(200);
    expect(notificationPreferencesSchema.parse(await res.json())).toMatchObject({ lockScreen: "detailed", invites: true });
    expect((await get(a)).lockScreen).toBe("detailed");
    expect((await get(b)).lockScreen).toBe("hidden");
    // 種別を変えても、見え方は残る
    await u.call("PATCH", "/api/v1/me/notification-preferences", { token: a.token, body: { invites: false } });
    expect(await get(a)).toMatchObject({ invites: false, lockScreen: "detailed" });
    for (const lockScreen of ["full", "", 1]) {
      const bad = await u.call("PATCH", "/api/v1/me/notification-preferences", { token: a.token, body: { lockScreen } });
      expect(bad.status).toBe(400);
    }
  });
});

describe("プッシュの本文", () => {
  it("出さない（初期値）：種類だけ。名前・日時・ひとこと・エリア・リンクは入らず、本文は暗号化されて長さがいつも同じ", async () => {
    const { a, b } = await pair();
    const { endpoint, keys } = await subscribeWithKeys(b);
    await flush(await invite(a, b));
    const [push] = await pushesTo(endpoint, keys);
    expect(push?.body).toBe("誘いが届きました");
    expect(push?.v).toBe(1);
    const raw = h.delivery.state.pushes.find((p) => p.url === endpoint);
    // 暗号化した本文にも、平文の名前などは出ない
    expect(new TextDecoder().decode(raw?.body ?? new Uint8Array())).not.toMatch(/あき|ひみつ|しぶや|example/);
    expect(JSON.stringify(push)).not.toMatch(/あき|11:00|ひみつ|しぶや|example/);
    expect(mailsTo(b)).toHaveLength(0);
  });

  it("名前と中身を出す：相手の名前と開始の日時（受け取り手のタイムゾーン）。ひとこと・エリア・リンクは出さない", async () => {
    const { a, b } = await pair();
    const { endpoint, keys } = await subscribeWithKeys(b);
    await setLockScreen(b, "detailed");
    await flush(await invite(a, b));
    const [push] = await pushesTo(endpoint, keys);
    expect(push?.body).toBe("あきさんから誘いが届きました\n10月11日(日) 11:00〜");
    expect(push?.body).not.toMatch(/ひみつ|しぶや|example/);

    // 「この時間なら」は代わりの時間を出す。送信者の設定（初期値）は種類だけ
    const sender = await subscribeWithKeys(a);
    const second = await invite(a, b, T("04:00"), T("05:00"));
    await respond(b, second, { response: "counter", startsAt: T("06:00"), endsAt: T("07:00") });
    await flush(second);
    expect((await pushesTo(sender.endpoint, sender.keys)).map((p) => p.body)).toEqual(["別の時間の提案があります"]);
    await setLockScreen(a, "detailed");
    const third = await invite(a, b, T("08:00"), T("09:00"));
    await respond(b, third, { response: "counter", startsAt: T("09:00"), endsAt: T("10:00") });
    await flush(third);
    expect((await pushesTo(sender.endpoint, sender.keys)).at(-1)?.body).toBe(
      "べにさんから別の時間の提案があります\n10月11日(日) 18:00〜",
    );
  });

  it("成立は嬉しい知らせとして届く。表示名がない相手は「名前未設定の友達さん」", async () => {
    const { a, b } = await pair();
    await env.DB.prepare("UPDATE users SET display_name = NULL WHERE id = ?1").bind(b.id).run();
    const { endpoint, keys } = await subscribeWithKeys(a);
    await setLockScreen(a, "detailed");
    const id = await invite(a, b);
    await respond(b, id, { response: "accept" });
    await flush(id);
    const bodies = (await pushesTo(endpoint, keys)).map((p) => p.body);
    expect(bodies).toEqual(["名前未設定の友達さんと予定が成立しました！\n10月11日(日) 11:00〜"]);
  });

  it("募集：決める前に応答者の名前を誰にも出さない。決まった知らせに出るのは募集者の名前だけ", async () => {
    const owner = await person("あき");
    const f1 = await person("べに");
    const f2 = await person("ちさ");
    for (const f of [f1, f2]) await u.befriend(owner, f);
    await flush(owner.id, ["FriendshipEstablished"]);
    h.delivery.state.pushes.length = 0;
    const subs = new Map<string, Awaited<ReturnType<typeof subscribeWithKeys>>>();
    for (const who of [owner, f1, f2]) {
      subs.set(who.id, await subscribeWithKeys(who));
      await setLockScreen(who, "detailed");
    }
    const created = await u.call("POST", "/api/v1/broadcasts", {
      token: owner.token,
      body: { recipientIds: [f1.id, f2.id], startsAt: T("02:00"), endsAt: T("03:00"), message: "ひみつ", area: "しぶや" },
    });
    const broadcastId = ((await created.json()) as { id: string }).id;
    await flush(broadcastId);
    await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f1.token });
    await flush(broadcastId);
    await flush(f1.id);
    const ownerSub = subs.get(owner.id);
    // 応じても、募集者にプッシュは届かない
    expect(ownerSub ? await pushesTo(ownerSub.endpoint, ownerSub.keys) : null).toEqual([]);
    await u.call("POST", `/api/v1/broadcasts/${broadcastId}/decide`, { token: owner.token });
    await flush(broadcastId);
    const f1Sub = subs.get(f1.id);
    const f2Sub = subs.get(f2.id);
    const f1Bodies = f1Sub ? (await pushesTo(f1Sub.endpoint, f1Sub.keys)).map((p) => p.body) : [];
    expect(f1Bodies).toEqual(["あきさんが募集しています\n10月11日(日) 11:00〜", "あきさんの募集が決まりました！\n10月11日(日) 11:00〜"]);
    // 参加者でない宛先には、決まったことも届かない
    expect(f2Sub ? (await pushesTo(f2Sub.endpoint, f2Sub.keys)).map((p) => p.body) : []).toEqual([
      "あきさんが募集しています\n10月11日(日) 11:00〜",
    ]);
    for (const bodies of [f1Bodies]) expect(bodies.join("\n")).not.toMatch(/べに|ちさ|ひみつ|しぶや/);
  });

  it("鍵のない購読（T-35 より前の登録）には、これまでどおり本文なしで送る", async () => {
    const { a, b } = await pair();
    const endpoint = endpointFor();
    expect((await u.call("POST", "/api/v1/push/subscriptions", { token: b.token, body: { endpoint } })).status).toBe(204);
    await flush(await invite(a, b));
    const push = h.delivery.state.pushes.find((p) => p.url === endpoint);
    expect(push?.bodyLength).toBe(0);
    expect(push?.headers["content-length"]).toBe("0");
    expect(push?.headers["content-encoding"]).toBeUndefined();
  });

  it("購読の鍵が読めない（壊れた・別の AAD）ときは、本文なしで送り、結果は sent", async () => {
    const { a, b } = await pair();
    const { endpoint } = await subscribeWithKeys(b);
    const broken = "v1.push-1.broken";
    await env.DB.prepare("UPDATE push_subscriptions SET keys_enc = ?2 WHERE user_id = ?1").bind(b.id, broken).run();
    await flush(await invite(a, b));
    const push = h.delivery.state.pushes.find((p) => p.url === endpoint);
    expect(push?.bodyLength).toBe(0);
    expect(push?.headers["content-length"]).toBe("0");
    expect(push?.headers["content-encoding"]).toBeUndefined();
    expect((await rowsOf(b)).at(-1)).toMatchObject({ kind: "invite_received", channel: "push", outcome: "sent" });
  });

  it("購読の鍵が別の人の AAD で暗号化されていても、本文なしで送る", async () => {
    const { a, b } = await pair();
    await subscribeWithKeys(a);
    const { endpoint } = await subscribeWithKeys(b);
    const aKeys = await env.DB.prepare("SELECT keys_enc FROM push_subscriptions WHERE user_id = ?1")
      .bind(a.id)
      .first<{ keys_enc: string }>();
    await env.DB.prepare("UPDATE push_subscriptions SET keys_enc = ?2 WHERE user_id = ?1").bind(b.id, aKeys?.keys_enc).run();
    await flush(await invite(a, b));
    const push = h.delivery.state.pushes.find((p) => p.url === endpoint);
    expect(push?.bodyLength).toBe(0);
    expect((await rowsOf(b)).at(-1)).toMatchObject({ kind: "invite_received", channel: "push", outcome: "sent" });
  });

  it("名前つきの文が詰め物の長さに入らなければ、種類だけの文にする（画面からは入らない長さの表示名で確かめる）", async () => {
    const { a, b } = await pair();
    await env.DB.prepare("UPDATE users SET display_name = ?2 WHERE id = ?1").bind(a.id, "あ".repeat(400)).run();
    const { endpoint, keys } = await subscribeWithKeys(b);
    await setLockScreen(b, "detailed");
    await flush(await invite(a, b));
    expect((await pushesTo(endpoint, keys)).map((p) => p.body)).toEqual(["誘いが届きました"]);
  });

  it("他人の設定や鍵で送らない：同じ誘いでも、受け取り手それぞれの見え方と鍵で暗号化する", async () => {
    const a = await person("あき");
    const b = await person("べに");
    const c = await person("ちさ");
    await u.befriend(a, b);
    await u.befriend(a, c);
    await flush(a.id, ["FriendshipEstablished"]);
    const bs = await subscribeWithKeys(b);
    const cs = await subscribeWithKeys(c);
    await setLockScreen(c, "detailed");
    await flush(await invite(a, b));
    await flush(await invite(a, c));
    expect((await pushesTo(bs.endpoint, bs.keys)).map((p) => p.body)).toEqual(["誘いが届きました"]);
    expect((await pushesTo(cs.endpoint, cs.keys)).map((p) => p.body)).toEqual(["あきさんから誘いが届きました\n10月11日(日) 11:00〜"]);
    // b の鍵では c あてのプッシュを読めない
    const toC = h.delivery.state.pushes.find((p) => p.url === cs.endpoint);
    await expect(decryptWebPush(toC?.body as Uint8Array, bs.keys)).rejects.toThrow();
  });
});

describe("鳴らさない知らせ", () => {
  it("断り・見送り・予定の取り消しは、プッシュもメールも送らず、お知らせ一覧にだけ残る", async () => {
    const { a, b } = await pair();
    const as = await subscribeWithKeys(a);
    await setLockScreen(a, "detailed");
    // 断り（送信者 a はプッシュの購読あり）
    const first = await invite(a, b);
    await respond(b, first, { response: "decline" });
    await flush(first);
    // 見送り（受信者 b は購読がないのでメールの人）
    const second = await invite(a, b, T("04:00"), T("05:00"));
    await respond(b, second, { response: "counter", startsAt: T("06:00"), endsAt: T("07:00") });
    await flush(second);
    await u.call("POST", `/api/v1/direct-invites/${second}/decide`, { token: a.token, body: { decision: "skip" } });
    await flush(second);
    // 予定の取り消し（b が成立させ、a が取り消す → b に届く）
    const third = await invite(a, b, T("08:00"), T("09:00"));
    await respond(b, third, { response: "accept" });
    await flush(third);
    const meetupId = (
      await env.DB.prepare("SELECT subject_id FROM notifications WHERE user_id = ?1 AND kind = 'meetup_confirmed'")
        .bind(a.id)
        .first<{ subject_id: string }>()
    )?.subject_id;
    await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: a.token });
    await flush(meetupId ?? "");

    const silent = [...(await rowsOf(a)), ...(await rowsOf(b))].filter((r) =>
      ["invite_declined", "invite_skipped", "meetup_cancelled"].includes(r.kind),
    );
    expect(silent.map((r) => r.kind).sort()).toEqual(["invite_declined", "invite_skipped", "meetup_cancelled"]);
    for (const r of silent) expect(r).toMatchObject({ channel: "none", outcome: "silent" });
    // a に届いたプッシュは「別の時間の提案」と「成立」だけ。b へのメールは誘いと成立の知らせだけ
    expect((await pushesTo(as.endpoint, as.keys)).map((p) => p.body.split("\n")[0])).toEqual([
      "べにさんから別の時間の提案があります",
      "べにさんと予定が成立しました！",
    ]);
    expect(mailsTo(b).map((m) => m.text)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/見送り|なくなりました/)]),
    );
    expect(mailsTo(a)).toHaveLength(0);
    // 一覧には残る
    const list = await (await u.call("GET", "/api/v1/notifications", { token: a.token })).json();
    expect(JSON.stringify(list)).toContain("invite_declined");
  });

  it("予定から1人抜けた知らせも鳴らさない", async () => {
    const owner = await person("あき");
    const f1 = await person("べに");
    const f2 = await person("ちさ");
    for (const f of [f1, f2]) await u.befriend(owner, f);
    await flush(owner.id, ["FriendshipEstablished"]);
    const created = await u.call("POST", "/api/v1/broadcasts", {
      token: owner.token,
      body: { recipientIds: [f1.id, f2.id], startsAt: T("02:00"), endsAt: T("03:00") },
    });
    const broadcastId = ((await created.json()) as { id: string }).id;
    await flush(broadcastId);
    for (const f of [f1, f2]) await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f.token });
    await u.call("POST", `/api/v1/broadcasts/${broadcastId}/decide`, { token: owner.token });
    await flush(broadcastId);
    const ownerSub = await subscribeWithKeys(owner);
    h.delivery.state.mails.length = 0;
    const meetupId = (
      await env.DB.prepare("SELECT id FROM meetups WHERE broadcast_id = ?1").bind(broadcastId).first<{ id: string }>()
    )?.id;
    expect((await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: f1.token })).status).toBeLessThan(300);
    await flush(meetupId ?? "");
    expect((await rowsOf(owner)).filter((r) => r.kind === "meetup_left")).toEqual([
      { kind: "meetup_left", channel: "none", outcome: "silent" },
    ]);
    expect(h.delivery.state.pushes.filter((p) => p.url === ownerSub.endpoint)).toHaveLength(0);
    expect(mailsTo(f2)).toHaveLength(0);
  });
});

describe("夜のプッシュ", () => {
  it("日本時間の22時〜7時は鳴らさず、メールにも切り替えず、お知らせ一覧にだけ残す。7時からはまた届く", async () => {
    const { a, b } = await pair();
    const { endpoint, keys } = await subscribeWithKeys(b);
    // 誘いは今の時計で作り、届ける時刻だけを動かす（アクセストークンの期限を越えないように）
    const ids = [
      await invite(a, b, T("02:00", "12"), T("03:00", "12")),
      await invite(a, b, T("04:00", "12"), T("05:00", "12")),
      await invite(a, b, T("06:00", "12"), T("07:00", "12")),
      await invite(a, b, T("08:00", "12"), T("09:00", "12")),
    ];
    // 12:59Z＝東京 21:59：届く／13:00Z＝22:00：鳴らさない／21:59Z＝6:59：鳴らさない／22:00Z＝7:00：届く
    const at = ["2026-10-10T12:59:00Z", "2026-10-10T13:00:00Z", "2026-10-10T21:59:00Z", "2026-10-10T22:00:00Z"];
    for (const [i, id] of ids.entries()) {
      h.clock.now = Date.parse(at[i] ?? "");
      await flush(id);
    }
    expect((await rowsOf(b)).filter((r) => r.kind === "invite_received").map((r) => r.outcome)).toEqual([
      "sent",
      "night",
      "night",
      "sent",
    ]);
    expect(await pushesTo(endpoint, keys)).toHaveLength(2);
    expect(mailsTo(b)).toHaveLength(0);
  });

  it("プッシュの購読がない人へのメールは、夜でも送る（夜に止めるのはプッシュだけ）", async () => {
    const { a, b } = await pair();
    const id = await invite(a, b, T("02:00", "12"), T("03:00", "12"));
    h.clock.now = Date.parse("2026-10-10T14:00:00Z") + HOUR;
    await flush(id);
    expect((await rowsOf(b)).at(-1)).toMatchObject({ kind: "invite_received", channel: "email", outcome: "sent" });
  });
});

describe("購読の鍵", () => {
  it("鍵は暗号化して保存し、平文で残さない。形の違う鍵は400。解除の本文に鍵は要らない", async () => {
    const { b } = await pair();
    const { endpoint, keys } = await subscribeWithKeys(b);
    const row = await env.DB.prepare("SELECT keys_enc FROM push_subscriptions WHERE user_id = ?1").bind(b.id).first<{ keys_enc: string }>();
    expect(row?.keys_enc).toMatch(/^v1\.push-1\./);
    expect(row?.keys_enc).not.toContain(keys.json.auth);
    expect(row?.keys_enc).not.toContain(keys.json.p256dh);

    const bad = [
      { p256dh: keys.json.p256dh.slice(1), auth: keys.json.auth },
      { p256dh: keys.json.p256dh, auth: `${keys.json.auth}AA` },
      // 先頭が 0x04 でない65バイト
      { p256dh: `C${keys.json.p256dh.slice(1)}`, auth: keys.json.auth },
      { p256dh: keys.json.p256dh },
      { p256dh: keys.json.p256dh, auth: keys.json.auth, extra: "x" },
    ];
    for (const k of bad) {
      const res = await u.call("POST", "/api/v1/push/subscriptions", { token: b.token, body: { endpoint: endpointFor(), keys: k } });
      expect(res.status).toBe(400);
    }
    expect((await u.call("DELETE", "/api/v1/push/subscriptions", { token: b.token, body: { endpoint } })).status).toBe(204);
    expect(
      (await u.call("DELETE", "/api/v1/push/subscriptions", { token: b.token, body: { endpoint, keys: keys.json } })).status,
    ).toBe(400);
  });

  it("同じ endpoint を別の人が登録すると、鍵もその人のものに替わる（前の人の鍵の行は残らない）", async () => {
    const { a, b } = await pair();
    const { endpoint } = await subscribeWithKeys(a);
    const next = await subscribeWithKeys(b, endpoint);
    const rows = await env.DB.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint_hash IN (SELECT endpoint_hash FROM push_subscriptions WHERE user_id = ?1)")
      .bind(b.id)
      .all<{ user_id: string }>();
    expect(rows.results.map((r) => r.user_id)).toEqual([b.id]);
    await flush(await invite(a, b));
    expect((await pushesTo(endpoint, next.keys)).map((p) => p.body)).toEqual(["誘いが届きました"]);
  });
});
