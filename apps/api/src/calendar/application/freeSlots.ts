import type { FreeSlots } from "@kokohima/shared";
import { presetWindows } from "../../availability/application/calendarFacing";
import { overlapsAny } from "../domain/busy";
import { ProviderUnavailable, ReauthRequired } from "../domain/provider";
import * as repo from "../infra/repository";
import { accessTokenFor, providerFor, type Ctx } from "./connections";

// カレンダーの空き（候補）。閲覧者がその場で見る読み取りなので、APIハンドラから Google を直接呼ぶ（決定事項11）
// 埋まりは保存しない。失敗しても 5xx にせず status: unavailable で返す

const iso = (ms: number) => new Date(ms).toISOString();
const empty = (status: FreeSlots["status"]): FreeSlots => ({ status, items: [], nextCursor: null });

export async function freeSlots(ctx: Ctx, viewerId: string, from: number, to: number): Promise<FreeSlots> {
  const row = await repo.findConnection(ctx.env.DB, viewerId, "google");
  if (!row || row.status === "disconnected") return empty("none");
  if (row.status === "needs_reauth") return empty("needs_reauth");

  const windows = await presetWindows(ctx, viewerId, from, to);
  if (windows.length === 0) return empty("ok");
  const span = { from: Math.min(...windows.map((w) => w.startsAt)), to: Math.max(...windows.map((w) => w.endsAt)) };

  let busy;
  try {
    const accessToken = await accessTokenFor(ctx, row);
    busy = await providerFor(ctx).busy(accessToken, span.from, span.to);
  } catch (e) {
    if (e instanceof ReauthRequired) return empty("needs_reauth");
    if (e instanceof ProviderUnavailable) return empty("unavailable");
    throw e;
  }
  return {
    status: "ok",
    items: windows
      .filter((w) => !overlapsAny(w, busy))
      .map((w) => ({ date: w.date, preset: w.preset, startsAt: iso(w.startsAt), endsAt: iso(w.endsAt) })),
    nextCursor: null,
  };
}
