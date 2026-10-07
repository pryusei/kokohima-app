import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthProvider";

export type Route = (req: { url: string; init: RequestInit }) => Response | Promise<Response>;

/** パスごとに応答を決める fetch のモック。呼ばれたリクエストを記録する */
export function mockFetch(routes: Record<string, Route | Route[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const counters = new Map<string, number>();
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const path = url.split("?")[0] ?? url;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    if (Array.isArray(route)) {
      const n = counters.get(path) ?? 0;
      counters.set(path, n + 1);
      const r = route[Math.min(n, route.length - 1)];
      if (!r) throw new Error("no route");
      return r({ url, init });
    }
    return route({ url, init });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

export const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const tokenBody = (accessToken = "access-1") => ({
  accessToken,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});

export function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider skipInitialRefresh={window.location.pathname === "/auth/complete"}>
        <App />
      </AuthProvider>
    </QueryClientProvider>,
  );
}
