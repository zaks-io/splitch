import { createSentryBeforeSend, secretsFromEnv } from "@splitch/observability/emitter";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export async function getRouter() {
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
  });
  if (typeof window !== "undefined") {
    const Sentry = await import("@sentry/react");
    const secrets = secretsFromEnv({
      SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
      SPLITCH_PLATFORM_TARGET: import.meta.env.VITE_SPLITCH_PLATFORM_TARGET ?? import.meta.env.MODE,
    });
    if (secrets.sentryDsn) {
      Sentry.init({
        dsn: secrets.sentryDsn,
        environment: secrets.environment,
        release: import.meta.env.VITE_SENTRY_RELEASE,
        tracesSampleRate: secrets.environment === "production" ? 0.1 : 1,
        integrations: [Sentry.tanstackRouterBrowserTracingIntegration(router)],
        beforeSend: createSentryBeforeSend({ surface: "marketing" }),
      } as unknown as Parameters<typeof Sentry.init>[0]);
    }
  }
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: Awaited<ReturnType<typeof getRouter>>;
  }
}
