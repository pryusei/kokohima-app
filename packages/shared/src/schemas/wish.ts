import * as z from "zod";
import { areaSchema, linkPreviewSchema, linkUrlSchema, messageSchema } from "./invitation";
import { pageSchema } from "./pagination";
import { publicProfileSchema } from "./social";

// 行きたい（docs/specs/T-22-wishlist.md「API」）

/** 同時に置ける行きたいの数（決めたこと7） */
export const WISH_MAX_ACTIVE = 10;
/** 直近24時間に置ける回数（決めたこと7） */
export const WISH_MAX_POSTS_PER_DAY = 20;
/** 1つの行きたいで見せない相手にできる人数（決めたこと9） */
export const WISH_MAX_EXCLUDED = 100;

const excludedUserIdsSchema = z
  .array(z.uuid())
  .max(WISH_MAX_EXCLUDED)
  .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate" });

/** ひとことは必須（前後の空白を除いて空なら400） */
const requiredMessageSchema = messageSchema.refine((v) => v !== null, { message: "required" });

export const createWishRequestSchema = z
  .object({
    message: requiredMessageSchema,
    // area・url は省略すると null（誘い・募集の作成と同じ）。excludedUserIds は必須
    area: areaSchema,
    url: linkUrlSchema,
    excludedUserIds: excludedUserIdsSchema,
  })
  .strict();
export type CreateWishRequest = z.input<typeof createWishRequestSchema>;

export const updateWishExclusionsRequestSchema = z.object({ userIds: excludedUserIdsSchema }).strict();
export type UpdateWishExclusionsRequest = z.input<typeof updateWishExclusionsRequestSchema>;

/** 置いた人でも友達でも項目は同じ。excludedUsers は置いた人にだけ配列、友達には null */
export const wishSchema = z.object({
  id: z.uuid(),
  owner: publicProfileSchema,
  message: z.string(),
  area: z.string().nullable(),
  url: z.string().nullable(),
  linkPreview: linkPreviewSchema.nullable(),
  createdAt: z.iso.datetime(),
  excludedUsers: z.array(publicProfileSchema).nullable(),
});
export type Wish = z.infer<typeof wishSchema>;

export const wishListSchema = pageSchema(wishSchema);

export const friendWishGroupSchema = z.object({ friend: publicProfileSchema, wishes: z.array(wishSchema) });
export type FriendWishGroup = z.infer<typeof friendWishGroupSchema>;
export const friendWishGroupPageSchema = pageSchema(friendWishGroupSchema);
