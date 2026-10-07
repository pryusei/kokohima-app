import { QueryClient } from "@tanstack/react-query";

// キャッシュは永続化しない（個人情報を含むため。data-fetching スキル参照）
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: true },
    },
  });
}
