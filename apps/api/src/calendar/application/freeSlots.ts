import { RETENTION, type FreeSlots } from "@kokohima/shared";
import { presetWindows } from "../../availability/application/calendarFacing";
import { overlapsAny } from "../domain/busy";
import { ProviderUnavailable, ReauthRequired } from "../domain/provider";
import { cached } from "../../shared/cache";
import * as repo from "../infra/repository";
import { accessTokenFor, providerFor, type Ctx } from "./connections";

// カレンダーの空き（候補）。閲覧者がその場で見る読み取りなので、APIハンドラから Google を直接呼ぶ（決定事項11）
// 埋まりは D1 に保存しない。freeBusy の埋まりの時刻だけを KV に5分キャッシュする（T-10）
// 失敗しても 5xx にせず status: unavailable で返す

/** キャッシュの秒数。Google に足した予定が最大この時間は候補に残る */
export const FREE_BUSY_CACHE_SECONDS = RETENTION.freeBusyCacheMinutes * 60;

const iso = (ms: number) => new Date(ms).toISOString();
const empty = (status: FreeSlots["status"]): FreeSlots => ({ status, items: [], nextCursor: null });

export async function freeSlots(ctx: Ctx, viewerId: string, from: number, to: number): Promise<FreeSlots> {
  // 退会した人（T-16）は、手元のアクセストークンが切れるまでの間も連携していない扱い（Google を呼ばない）
  const row = await repo.findConnectionOfActiveUser(ctx.env.DB, viewerId, "google");
  if (!row || row.status === "disconnected") return empty("none");
  if (row.status === "needs_reauth") return empty("needs_reauth");

  const windows = await presetWindows(ctx, viewerId, from, to);
  if (windows.length === 0) return empty("ok");
  const span = { from: Math.min(...windows.map((w) => w.startsAt)), to: Math.max(...windows.map((w) => w.endsAt)) };

  let busy;
  try {
    // キーに連携の connected_at と実際の範囲を入れる：つなぎ直したあと・プリセットを変えたあとは取り直す
    const key = `freebusy:v1:${viewerId}:${row.connected_at}:${span.from}:${span.to}`;
    busy = await cached(ctx, key, FREE_BUSY_CACHE_SECONDS, async () => {
      const accessToken = await accessTokenFor(ctx, row);
      return providerFor(ctx).busy(accessToken, span.from, span.to);
    });
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
