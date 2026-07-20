import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import type { FlagConfigApi } from "./lib/flag-config-api";
import { routeTree } from "./routeTree.gen";

export function getRouter(options: { flagConfigApi?: FlagConfigApi } = {}) {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient, flagConfigApi: options.flagConfigApi },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
