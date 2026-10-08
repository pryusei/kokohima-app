import { directInvitePageSchema, directInviteSchema, meetupPageSchema, meetupSchema } from "@kokohima/shared";
import { apiGet } from "../api/client";
import { keys } from "../api/keys";

// 誘いと成立した予定の取得（data-fetching スキル：キーは keys.ts の工場から）

export const invitesQuery = (box: "received" | "sent") => ({
  queryKey: keys.invites.list(box),
  queryFn: () => apiGet(`/api/v1/direct-invites?box=${box}&limit=50`, directInvitePageSchema),
});

export const inviteQuery = (id: string) => ({
  queryKey: keys.invites.detail(id),
  queryFn: () => apiGet(`/api/v1/direct-invites/${encodeURIComponent(id)}`, directInviteSchema),
});

export const meetupsQuery = () => ({
  queryKey: keys.meetups.list(),
  queryFn: () => apiGet("/api/v1/meetups?limit=50", meetupPageSchema),
});

export const meetupQuery = (id: string) => ({
  queryKey: keys.meetups.detail(id),
  queryFn: () => apiGet(`/api/v1/meetups/${encodeURIComponent(id)}`, meetupSchema),
});
