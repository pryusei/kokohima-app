import { env } from "cloudflare:workers";
import {
  friendAvailabilityPageSchema,
  friendSchema,
  myAvailabilityListSchema,
  presetsSchema,
  recurrenceRuleListSchema,
  slotListSchema,
} from "@kokohima/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { DAY_MS } from "./domain/zonedTime";

// 時計は 2026-10-10T00:00:00Z（土曜、東京は 09:00）
let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

const iso = (ms: number) => new Date(ms).toISOString();
const range = (fromMs: number, days: number) => `from=${iso(fromMs)}&to=${iso(fromMs + days * DAY_MS)}`;

async function addPreset(owner: User, date: string, preset: "day" | "evening" | "night") {
  return u.call("POST", "/api/v1/availabilities", { token: owner.token, body: { date, preset } });
}

async function addRange(owner: User, startsAt: string, endsAt: string) {
  return u.call("POST", "/api/v1/availabilities", { token: owner.token, body: { startsAt, endsAt } });
}

async function mine(owner: User, days = 14) {
  const res = await u.call("GET", `/api/v1/availabilities?${range(h.clock.now, days)}`, { token: owner.token });
  return myAvailabilityListSchema.parse(await res.json()).items;
}

async function everyone(viewer: User, days = 14, cursor?: string) {
  const q = `${range(h.clock.now, days)}${cursor ? `&cursor=${cursor}` : ""}`;
  const res = await u.call("GET", `/api/v1/friend-availabilities?${q}`, { token: viewer.token });
  expect(res.status).toBe(200);
  return friendAvailabilityPageSchema.parse(await res.json());
}

async function friendSlots(viewer: User, friendId: string, days = 14) {
  return u.call("GET", `/api/v1/friends/${friendId}/availabilities?${range(h.clock.now, days)}`, { token: viewer.token });
}

async function hide(owner: User, from: User) {
  const res = await u.call("PATCH", `/api/v1/friends/${from.id}`, {
    token: owner.token,
    body: { sharesMyAvailability: false },
  });
  expect(res.status).toBe(200);
}

describe("時間帯プリセット", () => {
  it("初期値を返し、3つまとめて置き換えられる。不正な値は400", async () => {
    const a = await u.user();
    const initial = presetsSchema.parse(await (await u.call("GET", "/api/v1/me/presets", { token: a.token })).json());
    expect(initial).toEqual({
      day: { start: "11:00", end: "15:00" },
      evening: { start: "16:00", end: "19:00" },
      night: { start: "19:00", end: "23:00" },
    });
    const next = { ...initial, night: { start: "20:00", end: "24:00" } };
    const put = await u.call("PUT", "/api/v1/me/presets", { token: a.token, body: next });
    expect(presetsSchema.parse(await put.json())).toEqual(next);
    for (const night of [
      { start: "20:10", end: "23:00" }, // 15分単位でない
      { start: "22:00", end: "22:15" }, // 30分未満
      { start: "23:00", end: "22:00" }, // 日をまたぐ
    ]) {
      expect((await u.call("PUT", "/api/v1/me/presets", { token: a.token, body: { ...initial, night } })).status).toBe(400);
    }
  });

  it("変更しても、すでにある枠とルールの時刻は変わらない", async () => {
    const a = await u.user();
    await addPreset(a, "2026-10-10", "night");
    await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 0, preset: "night" } });
    await u.call("PUT", "/api/v1/me/presets", {
      token: a.token,
      body: {
        day: { start: "11:00", end: "15:00" },
        evening: { start: "16:00", end: "19:00" },
        night: { start: "21:00", end: "24:00" },
      },
    });
    const items = await mine(a, 3);
    expect(items.map((i) => [i.startsAt, i.endsAt])).toEqual([
      ["2026-10-10T10:00:00.000Z", "2026-10-10T14:00:00.000Z"],
      ["2026-10-11T10:00:00.000Z", "2026-10-11T14:00:00.000Z"],
    ]);
    const rules = recurrenceRuleListSchema.parse(
      await (await u.call("GET", "/api/v1/recurrence-rules", { token: a.token })).json(),
    );
    expect(rules.items[0]).toMatchObject({ start: "19:00", end: "23:00", label: "night" });
  });
});

describe("ここ暇の追加・一覧・取り消し", () => {
  it("プリセット指定は閲覧者のプリセットの時刻で作り、label を付ける", async () => {
    const a = await u.user();
    const res = await addPreset(a, "2026-10-10", "night");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      startsAt: "2026-10-10T10:00:00.000Z",
      endsAt: "2026-10-10T14:00:00.000Z",
      label: "night",
      source: "manual",
      date: null,
    });
  });

  it("プリセット指定は夏時間の切り替え日にも規則どおり（America/New_York）", async () => {
    const a = await u.user();
    await env.DB.prepare("UPDATE users SET timezone = 'America/New_York' WHERE id = ?").bind(a.id).run();
    await u.call("PUT", "/api/v1/me/presets", {
      token: a.token,
      body: {
        day: { start: "01:00", end: "04:00" },
        evening: { start: "16:00", end: "19:00" },
        night: { start: "19:00", end: "23:00" },
      },
    });
    h.clock.now = Date.parse("2026-10-30T00:00:00Z");
    await u.advance(0, a);
    const res = await addPreset(a, "2026-11-01", "day");
    expect(await res.json()).toMatchObject({ startsAt: "2026-11-01T05:00:00.000Z", endsAt: "2026-11-01T09:00:00.000Z" });
  });

  it("開始〜終了指定。過去・60日より先・15分単位でない・30分未満・24時間超は400", async () => {
    const a = await u.user();
    expect((await addRange(a, "2026-10-10T10:00:00Z", "2026-10-10T12:00:00Z")).status).toBe(201);
    // 開始は過去でもよい（今から暇）
    expect((await addRange(a, "2026-10-09T23:00:00Z", "2026-10-10T01:00:00Z")).status).toBe(201);
    for (const [s, e] of [
      ["2026-10-09T10:00:00Z", "2026-10-09T12:00:00Z"],
      ["2026-12-15T10:00:00Z", "2026-12-15T12:00:00Z"],
      ["2026-10-11T10:10:00Z", "2026-10-11T12:00:00Z"],
      ["2026-10-11T10:00:00Z", "2026-10-11T10:15:00Z"],
      ["2026-10-11T10:00:00Z", "2026-10-12T10:15:00Z"],
    ]) {
      expect((await addRange(a, s as string, e as string)).status).toBe(400);
    }
  });

  it("自分の手動の枠と重なれば409。くり返しとは重なってもよい", async () => {
    const a = await u.user();
    await addPreset(a, "2026-10-10", "night");
    expect((await addRange(a, "2026-10-10T13:00:00Z", "2026-10-10T15:00:00Z")).status).toBe(409);
    expect((await addRange(a, "2026-10-10T14:00:00Z", "2026-10-10T15:00:00Z")).status).toBe(201); // 接するだけ
    await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 0, preset: "night" } });
    expect((await addPreset(a, "2026-10-11", "night")).status).toBe(201);
  });

  it("同じ枠を同時に2回送っても1つしかできない", async () => {
    const a = await u.user();
    const results = await Promise.all([addPreset(a, "2026-10-10", "night"), addPreset(a, "2026-10-10", "night")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await mine(a, 2)).toHaveLength(1);
  });

  it("未来の手動の枠は100個まで（同時に送っても超えない）", async () => {
    const a = await u.user();
    const base = Date.parse("2026-10-10T01:00:00Z");
    for (let i = 0; i < 98; i++) {
      const s = base + i * 3 * 60 * 60 * 1000;
      expect((await addRange(a, iso(s), iso(s + 60 * 60 * 1000))).status).toBe(201);
    }
    const s = base + 98 * 3 * 60 * 60 * 1000;
    const results = await Promise.all(
      [0, 1, 2].map((j) => addRange(a, iso(s + j * 3 * 60 * 60 * 1000), iso(s + j * 3 * 60 * 60 * 1000 + 3600000))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM availabilities WHERE user_id = ?").bind(a.id).first<{ n: number }>();
    expect(rows?.n).toBe(100);
  });

  it("自分の一覧：手動とくり返しの展開を開始日時の順で返し、過去の枠を含まない。範囲の検証", async () => {
    const a = await u.user();
    await addPreset(a, "2026-10-11", "day");
    await addRange(a, "2026-10-09T10:00:00Z", "2026-10-09T23:00:00Z"); // 400（過去）なので無視される
    await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 6, preset: "night" } });
    const items = await mine(a, 8);
    expect(items.map((i) => [i.source, i.date, i.label])).toEqual([
      ["recurrence", "2026-10-10", "night"],
      ["manual", null, "day"],
      ["recurrence", "2026-10-17", "night"],
    ]);
    const bad = `from=${iso(h.clock.now)}&to=${iso(h.clock.now + 32 * DAY_MS)}`;
    expect((await u.call("GET", `/api/v1/availabilities?${bad}`, { token: a.token })).status).toBe(400);
    const reversed = `from=${iso(h.clock.now + DAY_MS)}&to=${iso(h.clock.now)}`;
    expect((await u.call("GET", `/api/v1/availabilities?${reversed}`, { token: a.token })).status).toBe(400);
  });

  it("取り消し：自分の枠は204、他人の枠・存在しないIDは同じ404", async () => {
    const a = await u.user();
    const b = await u.user();
    const created = (await (await addPreset(a, "2026-10-10", "night")).json()) as { id: string };
    expect((await u.call("DELETE", `/api/v1/availabilities/${created.id}`, { token: b.token })).status).toBe(404);
    expect(await mine(a, 2)).toHaveLength(1);
    expect((await u.call("DELETE", `/api/v1/availabilities/${created.id}`, { token: a.token })).status).toBe(204);
    expect((await u.call("DELETE", `/api/v1/availabilities/${crypto.randomUUID()}`, { token: a.token })).status).toBe(404);
  });
});

describe("くり返し", () => {
  it("追加・一覧・削除。同じ曜日で重なれば409、20個で409", async () => {
    const a = await u.user();
    const create = (body: unknown) => u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body });
    expect((await create({ weekday: 6, preset: "night" })).status).toBe(201);
    expect((await create({ weekday: 6, start: "22:00", end: "24:00" })).status).toBe(409);
    expect((await create({ weekday: 6, start: "23:00", end: "24:00" })).status).toBe(201); // 接するだけ
    expect((await create({ weekday: 1, start: "10:10", end: "11:00" })).status).toBe(400);
    for (let i = 0; i < 18; i++) {
      const start = `${String(i).padStart(2, "0")}:00`;
      const end = `${String(i).padStart(2, "0")}:30`;
      expect((await create({ weekday: 3, start, end })).status).toBe(201);
    }
    expect((await create({ weekday: 4, start: "10:00", end: "11:00" })).status).toBe(409);
    const list = recurrenceRuleListSchema.parse(await (await u.call("GET", "/api/v1/recurrence-rules", { token: a.token })).json());
    expect(list.items).toHaveLength(20);
    const first = list.items[0];
    expect((await u.call("DELETE", `/api/v1/recurrence-rules/${first?.id}`, { token: a.token })).status).toBe(204);
  });

  it("例外で外す・戻す（冪等）。曜日違い・過去・60日より先は400。一覧に今日以降の例外が出る。ルールを消すと例外も消える", async () => {
    const a = await u.user();
    const rule = (await (
      await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 6, preset: "night" } })
    ).json()) as { id: string };
    const skip = (date: string) =>
      u.call("POST", `/api/v1/recurrence-rules/${rule.id}/exceptions`, { token: a.token, body: { date } });
    expect((await skip("2026-10-17")).status).toBe(204);
    expect((await skip("2026-10-17")).status).toBe(204);
    expect((await skip("2026-10-18")).status).toBe(400); // 日曜
    expect((await skip("2026-10-03")).status).toBe(400); // 過去
    expect((await skip("2026-12-19")).status).toBe(400); // 60日より先
    expect((await mine(a, 15)).map((i) => i.date)).toEqual(["2026-10-10", "2026-10-24"]);
    const list = recurrenceRuleListSchema.parse(await (await u.call("GET", "/api/v1/recurrence-rules", { token: a.token })).json());
    expect(list.items[0]?.exceptions).toEqual(["2026-10-17"]);
    const restore = () => u.call("DELETE", `/api/v1/recurrence-rules/${rule.id}/exceptions/2026-10-17`, { token: a.token });
    expect((await restore()).status).toBe(204);
    expect((await restore()).status).toBe(204);
    expect((await mine(a, 15)).map((i) => i.date)).toEqual(["2026-10-10", "2026-10-17", "2026-10-24"]);
    await skip("2026-10-17");
    await u.call("DELETE", `/api/v1/recurrence-rules/${rule.id}`, { token: a.token });
    const left = await env.DB.prepare("SELECT * FROM recurrence_exceptions WHERE rule_id = ?").bind(rule.id).all();
    expect(left.results).toHaveLength(0);
  });

  it("他人のルールは削除・例外の操作ができず、同じ404", async () => {
    const a = await u.user();
    const b = await u.user();
    const rule = (await (
      await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 6, preset: "night" } })
    ).json()) as { id: string };
    expect((await u.call("DELETE", `/api/v1/recurrence-rules/${rule.id}`, { token: b.token })).status).toBe(404);
    expect(
      (await u.call("POST", `/api/v1/recurrence-rules/${rule.id}/exceptions`, { token: b.token, body: { date: "2026-10-17" } }))
        .status,
    ).toBe(404);
    expect(
      (await u.call("DELETE", `/api/v1/recurrence-rules/${rule.id}/exceptions/2026-10-17`, { token: b.token })).status,
    ).toBe(404);
    expect(await mine(a, 14)).toHaveLength(2);
  });
});

describe("みんな", () => {
  it("友達の手動の枠とくり返しの展開が出る。範囲と重なる枠は切り詰めずに出る", async () => {
    const a = await u.user("あき");
    const b = await u.user("びー");
    await u.befriend(a, b);
    await addPreset(a, "2026-10-12", "day");
    await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 6, preset: "night" } });
    const page = await everyone(b, 8);
    expect(page.items.map((i) => [i.friend.displayName, i.startsAt, i.label])).toEqual([
      ["あき", "2026-10-10T10:00:00.000Z", "night"],
      ["あき", "2026-10-12T02:00:00.000Z", "day"],
      ["あき", "2026-10-17T10:00:00.000Z", "night"],
    ]);
    // 範囲 [11:00Z, 12:00Z) は 10:00〜14:00Z の枠と重なる。切り詰めない
    const q = `from=2026-10-10T11:00:00.000Z&to=2026-10-10T12:00:00.000Z`;
    const narrow = friendAvailabilityPageSchema.parse(
      await (await u.call("GET", `/api/v1/friend-availabilities?${q}`, { token: b.token })).json(),
    );
    expect(narrow.items.map((i) => [i.startsAt, i.endsAt])).toEqual([["2026-10-10T10:00:00.000Z", "2026-10-10T14:00:00.000Z"]]);
    const after = `from=2026-10-10T14:00:00.000Z&to=2026-10-10T15:00:00.000Z`;
    const none = friendAvailabilityPageSchema.parse(
      await (await u.call("GET", `/api/v1/friend-availabilities?${after}`, { token: b.token })).json(),
    );
    expect(none.items).toHaveLength(0);
    expect((await u.call("GET", `/api/v1/friend-availabilities?${range(h.clock.now, 15)}`, { token: b.token })).status).toBe(400);
  });

  it("見せない相手・ここ暇がない相手・友達でない人・片方向の行しかない相手は、どれも結果に出ない", async () => {
    const viewer = await u.user();
    const [hidden, empty, stranger, oneWay, shown] = [await u.user(), await u.user(), await u.user(), await u.user(), await u.user()];
    for (const f of [hidden, empty, oneWay, shown]) await u.befriend(f, viewer);
    for (const f of [hidden, stranger, oneWay, shown]) await addPreset(f, "2026-10-11", "night");
    await hide(hidden, viewer);
    await env.DB.prepare("DELETE FROM friendships WHERE user_id = ? AND friend_id = ?").bind(oneWay.id, viewer.id).run();
    const page = await everyone(viewer, 7);
    expect(page.items.map((i) => i.friend.id)).toEqual([shown.id]);
  });

  it("友達の枠に、ID・作成日時・手動かくり返しかを含めない", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    await addPreset(a, "2026-10-11", "night");
    const [item] = (await everyone(b, 7)).items;
    expect(Object.keys(item ?? {}).sort()).toEqual(["endsAt", "friend", "label", "overlapsMine", "startsAt"]);
    expect(Object.keys(item?.friend ?? {}).sort()).toEqual(["avatarUrl", "displayName", "id"]);
  });

  it("同じ友達の重なる枠はまとまり、自分の枠（手動・くり返し）と重なれば overlapsMine", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    await addPreset(a, "2026-10-11", "night"); // 10:00〜14:00Z
    await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 0, start: "22:00", end: "24:00" } }); // 13:00〜15:00Z
    await u.call("POST", "/api/v1/recurrence-rules", { token: b.token, body: { weekday: 0, start: "23:30", end: "24:00" } });
    await addPreset(a, "2026-10-12", "day");
    const items = (await everyone(b, 7)).items;
    expect(items.map((i) => [i.startsAt, i.endsAt, i.label, i.overlapsMine])).toEqual([
      ["2026-10-11T10:00:00.000Z", "2026-10-11T15:00:00.000Z", null, true],
      ["2026-10-12T02:00:00.000Z", "2026-10-12T06:00:00.000Z", "day", false],
    ]);
  });

  it("500件を超えると nextCursor で続きを取れ、境目で分かれたり重複したりしない", async () => {
    const viewer = await u.user();
    const friends: User[] = [];
    for (let i = 0; i < 6; i++) {
      const f = await u.user(`f${i}`);
      await u.befriend(f, viewer);
      friends.push(f);
    }
    // 6人×100枠 = 600件（同じ友達の枠は重ならない）
    const statements = friends.flatMap((f) =>
      Array.from({ length: 100 }, (_, j) => {
        const s = h.clock.now + j * 3 * 60 * 60 * 1000 + 15 * 60 * 1000;
        return env.DB.prepare(
          "INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
        ).bind(crypto.randomUUID(), f.id, s, s + 60 * 60 * 1000, h.clock.now);
      }),
    );
    await env.DB.batch(statements);
    const p1 = await everyone(viewer, 14);
    expect(p1.items).toHaveLength(500);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await everyone(viewer, 14, p1.nextCursor ?? undefined);
    expect(p2.items).toHaveLength(100);
    expect(p2.nextCursor).toBeNull();
    const keys = [...p1.items, ...p2.items].map((i) => `${i.friend.id}|${i.startsAt}`);
    expect(new Set(keys).size).toBe(600);
    expect((await u.call("GET", `/api/v1/friend-availabilities?${range(h.clock.now, 7)}&cursor=broken`, { token: viewer.token })).status).toBe(400);
  });

  it("処理量の目安：友達100人が上限いっぱい（手動100個＋ルール20個）でも時間内に返る", async () => {
    const viewer = await u.user();
    const now = h.clock.now;
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    const statements: D1PreparedStatement[] = [];
    for (const id of ids) {
      statements.push(
        env.DB.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'x', ?, ?)").bind(id, now, now),
        env.DB.prepare("INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)").bind(viewer.id, id, now),
        env.DB.prepare("INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)").bind(id, viewer.id, now),
      );
      for (let j = 0; j < 100; j++) {
        const s = now + j * 12 * 60 * 60 * 1000;
        statements.push(
          env.DB.prepare(
            "INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
          ).bind(crypto.randomUUID(), id, s, s + 60 * 60 * 1000, now),
        );
      }
      for (let w = 0; w < 20; w++) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO recurrence_rules (id, user_id, weekday, start_minute, end_minute, label, timezone, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'Asia/Tokyo', ?)",
          ).bind(crypto.randomUUID(), id, w % 7, (w % 3) * 360, (w % 3) * 360 + 60, now),
        );
      }
    }
    for (let i = 0; i < statements.length; i += 500) await env.DB.batch(statements.slice(i, i + 500));
    const started = performance.now();
    const page = await everyone(viewer, 14);
    const elapsed = performance.now() - started;
    expect(page.items.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("友達の詳細", () => {
  it("友達でない・片方向なら404。見せない相手はここ暇がない相手と同じ空の一覧", async () => {
    const viewer = await u.user();
    const [hidden, empty, stranger, oneWay] = [await u.user(), await u.user(), await u.user(), await u.user()];
    for (const f of [hidden, empty, oneWay]) await u.befriend(f, viewer);
    await addPreset(hidden, "2026-10-11", "night");
    await hide(hidden, viewer);
    await env.DB.prepare("DELETE FROM friendships WHERE user_id = ? AND friend_id = ?").bind(oneWay.id, viewer.id).run();

    const hiddenRes = await friendSlots(viewer, hidden.id);
    const emptyRes = await friendSlots(viewer, empty.id);
    expect(hiddenRes.status).toBe(200);
    expect(await hiddenRes.text()).toBe(await emptyRes.text());
    expect((await friendSlots(viewer, stranger.id)).status).toBe(404);
    expect((await friendSlots(viewer, oneWay.id)).status).toBe(404);
    expect((await friendSlots(viewer, crypto.randomUUID())).status).toBe(404);
  });

  it("見えている枠を返す（slotSchema だけ）", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    await addPreset(a, "2026-10-11", "night");
    const list = slotListSchema.parse(await (await friendSlots(b, a.id)).json());
    expect(list.items).toEqual([{ startsAt: "2026-10-11T10:00:00.000Z", endsAt: "2026-10-11T14:00:00.000Z", label: "night" }]);
  });

  it("GET /friends/{friendId}：友達なら表示名と公開設定、友達でない・片方向なら404", async () => {
    const a = await u.user("あき");
    const b = await u.user();
    const c = await u.user();
    await u.befriend(a, b);
    const res = await u.call("GET", `/api/v1/friends/${a.id}`, { token: b.token });
    expect(friendSchema.parse(await res.json())).toMatchObject({ id: a.id, displayName: "あき", sharesMyAvailability: true });
    expect((await u.call("GET", `/api/v1/friends/${c.id}`, { token: b.token })).status).toBe(404);
    await env.DB.prepare("DELETE FROM friendships WHERE user_id = ? AND friend_id = ?").bind(a.id, b.id).run();
    expect((await u.call("GET", `/api/v1/friends/${a.id}`, { token: b.token })).status).toBe(404);
  });
});

describe("ルートの振り分けと他人のID", () => {
  it("/friend-availabilities はみんな、/friends/{id} は social、/friends/{id}/availabilities は友達の詳細に届く", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    expect((await u.call("GET", `/api/v1/friend-availabilities?${range(h.clock.now, 7)}`, { token: b.token })).status).toBe(200);
    expect(friendSchema.safeParse(await (await u.call("GET", `/api/v1/friends/${a.id}`, { token: b.token })).json()).success).toBe(true);
    expect(slotListSchema.safeParse(await (await friendSlots(b, a.id)).json()).success).toBe(true);
  });

  it("BがAに見せていない枠は、Aのどの一覧にも出ない", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    await addPreset(b, "2026-10-11", "night");
    await u.call("POST", "/api/v1/recurrence-rules", { token: b.token, body: { weekday: 1, preset: "day" } });
    await hide(b, a);
    expect((await everyone(a, 14)).items).toHaveLength(0);
    expect(slotListSchema.parse(await (await friendSlots(a, b.id)).json()).items).toHaveLength(0);
    expect(await mine(a, 14)).toHaveLength(0);
  });

  it("認証がなければ401", async () => {
    expect((await u.call("GET", `/api/v1/friend-availabilities?${range(h.clock.now, 7)}`)).status).toBe(401);
    expect((await u.call("POST", "/api/v1/availabilities", { body: { date: "2026-10-10", preset: "night" } })).status).toBe(401);
    expect((await u.call("GET", "/api/v1/me/presets")).status).toBe(401);
  });
});
