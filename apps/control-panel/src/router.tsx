import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import type { FlagConfigApi } from "./lib/flag-config-api";
import { initControlPanelClientSentry } from "./lib/panel-sentry-client";
import { routeTree } from "./routeTree.gen";

export async function getRouter(options: { flagConfigApi?: FlagConfigApi } = {}) {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient, flagConfigApi: options.flagConfigApi },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
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
