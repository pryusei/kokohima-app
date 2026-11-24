import { notificationPreferencesSchema, type NotificationPreferences } from "@kokohima/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";

// 通知の設定の部分更新（docs/specs/T-07-notification.md「設定」、docs/specs/T-35-notification-visibility.md）。
// 楽観的に画面を変え、失敗したら元に戻す（data-fetching スキル）。設定の画面と、友達になった直後の画面で使う

export function useUpdatePreferences(onFailed?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<NotificationPreferences>) =>
      apiSend("PATCH", "/api/v1/me/notification-preferences", patch, notificationPreferencesSchema),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: keys.notifications.preferences() });
      const previous = queryClient.getQueryData<NotificationPreferences>(keys.notifications.preferences());
      queryClient.setQueryData<NotificationPreferences>(keys.notifications.preferences(), (p) => p && { ...p, ...patch });
      return { previous };
    },
    onError: (_err, _patch, context) => {
      onFailed?.();
      if (context?.previous) queryClient.setQueryData(keys.notifications.preferences(), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.notifications.preferences() }),
  });
}
