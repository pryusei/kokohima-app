import { notificationPageSchema, notificationPreferencesSchema, unreadCountSchema } from "@kokohima/shared";
import { apiGet } from "../api/client";
import { keys } from "../api/keys";

// お知らせの取得（docs/specs/T-07-notification.md「API」。data-fetching スキル：キーは keys.ts の工場から）

export const notificationsQuery = () => ({
  queryKey: keys.notifications.list(),
  queryFn: () => apiGet("/api/v1/notifications", notificationPageSchema),
});

export const unreadCountQuery = () => ({
  queryKey: keys.notifications.unread(),
  queryFn: () => apiGet("/api/v1/notifications/unread-count", unreadCountSchema),
});

export const preferencesQuery = () => ({
  queryKey: keys.notifications.preferences(),
  queryFn: () => apiGet("/api/v1/me/notification-preferences", notificationPreferencesSchema),
});
