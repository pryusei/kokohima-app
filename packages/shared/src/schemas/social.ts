import { z } from "zod";
import { pageSchema } from "./pagination";

// 友達と招待リンク（docs/specs/T-02-friends.md「API」）

/** 他人の公開プロフィール。ID・表示名・アイコンだけ */
export const publicProfileSchema = z.object({
  id: z.uuid(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type PublicProfile = z.infer<typeof publicProfileSchema>;

export const INVITE_EXPIRES_IN_DAYS = [1, 3, 7] as const;
export const INVITE_DEFAULTS = { expiresInDays: 3, maxUses: 5 } as const;

export const createInviteLinkRequestSchema = z.object({
  expiresInDays: z.union([z.literal(1), z.literal(3), z.literal(7)]).default(INVITE_DEFAULTS.expiresInDays),
  maxUses: z.number().int().min(1).max(10).default(INVITE_DEFAULTS.maxUses),
});
export type CreateInviteLinkRequest = z.input<typeof createInviteLinkRequestSchema>;

export const inviteLinkSchema = z.object({
  id: z.uuid(),
  expiresAt: z.iso.datetime(),
  maxUses: z.number().int(),
  uses: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type InviteLink = z.infer<typeof inviteLinkSchema>;

export const createdInviteLinkSchema = inviteLinkSchema.extend({ url: z.url() });
export type CreatedInviteLink = z.infer<typeof createdInviteLinkSchema>;

export const inviteLinkPageSchema = pageSchema(inviteLinkSchema);

export const inviteLookupRequestSchema = z.object({ token: z.string().min(1).max(128).optional() });

export const inviteLookupResponseSchema = z.object({
  linkId: z.uuid(),
  inviter: z.object({ displayName: z.string().nullable(), avatarUrl: z.string().nullable() }),
});
export type InviteLookupResponse = z.infer<typeof inviteLookupResponseSchema>;

export const acceptInviteRequestSchema = z.object({ linkId: z.uuid() });

export const acceptInviteResponseSchema = z.object({
  friend: publicProfileSchema,
  alreadyFriends: z.boolean(),
});
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;

export const friendSchema = publicProfileSchema.extend({
  sharesMyAvailability: z.boolean(),
  friendsSince: z.iso.datetime(),
});
export type Friend = z.infer<typeof friendSchema>;

export const friendPageSchema = pageSchema(friendSchema);

export const updateFriendRequestSchema = z.object({ sharesMyAvailability: z.boolean() });
