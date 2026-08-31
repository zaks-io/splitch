import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import type { FlagConfigApi } from "#lib/flags/flag-config-api";
import { initControlPanelClientSentry } from "#lib/observability/panel-sentry-client";
import { routeTree } from "./routeTree.gen";

const QUERY_STALE_TIME_MS = 60_000;
const PRELOAD_STALE_TIME_MS = 30_000;

export async function getRouter(options: { flagConfigApi?: FlagConfigApi } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
      },
    },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient, flagConfigApi: options.flagConfigApi },
    defaultPreload: "intent",
    defaultPreloadStaleTime: PRELOAD_STALE_TIME_MS,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });
  await initControlPanelClientSentry(router);
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: Awaited<ReturnType<typeof getRouter>>;
  }
}
