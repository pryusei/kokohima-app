import type { SafetySubject } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { findReceivedSubject, type ReceivedSubjectRow } from "../infra/safetyRepository";

// ブロックと通報（docs/specs/T-33-block-report.md「振る舞い 1.」）向け：閲覧者に届いた誘い・募集の送り主と中身。
// 閲覧者が受け取った側（誘いの相手・募集の宛先）のときだけ返し、それ以外（送った側・関係のない人・存在しない）は null。
// 中身はひとこと・リンク・日時・エリアだけ（予定の中身やカレンダーは持っていない）

type Ctx = { env: Bindings; deps: AppDeps };

export type ReceivedSubject = ReceivedSubjectRow;

export async function receivedSubjectOf(ctx: Ctx, viewerId: string, subject: SafetySubject): Promise<ReceivedSubject | null> {
  return findReceivedSubject(ctx.env.DB, viewerId, subject);
}
