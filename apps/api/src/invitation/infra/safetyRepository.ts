import type { SafetySubject } from "@kokohima/shared";

// ブロックと通報（docs/specs/T-33-block-report.md「振る舞い 1.」）向けの読み取り。閲覧者が受け取った側のときだけ行を返す

export type ReceivedSubjectRow = {
  senderId: string;
  startsAt: number;
  endsAt: number;
  area: string | null;
  message: string | null;
  url: string | null;
};

/** 誘いは recipient_id、募集は broadcast_recipients の行で、閲覧者が受け取った側であることを SQL の条件に入れる */
export async function findReceivedSubject(d1: D1Database, viewerId: string, subject: SafetySubject): Promise<ReceivedSubjectRow | null> {
  if (subject.type === "direct_invite") {
    return (
      (await d1
        .prepare(
          `SELECT sender_id AS senderId, starts_at AS startsAt, ends_at AS endsAt, area, message, url
           FROM direct_invites WHERE id = ?1 AND recipient_id = ?2`,
        )
        .bind(subject.id, viewerId)
        .first<ReceivedSubjectRow>()) ?? null
    );
  }
  return (
    (await d1
      .prepare(
        `SELECT b.owner_id AS senderId, b.starts_at AS startsAt, b.ends_at AS endsAt, b.area, b.message, b.url
         FROM broadcasts b JOIN broadcast_recipients r ON r.broadcast_id = b.id AND r.user_id = ?2
         WHERE b.id = ?1`,
      )
      .bind(subject.id, viewerId)
      .first<ReceivedSubjectRow>()) ?? null
  );
}
