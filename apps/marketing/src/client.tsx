import { browserTracingIntegration, init } from "@sentry/react";
import { createSentryBeforeSend, secretsFromEnv } from "@splitch/observability/emitter";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

const secrets = secretsFromEnv({
  SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
  SPLITCH_PLATFORM_TARGET: import.meta.env.VITE_SPLITCH_PLATFORM_TARGET ?? import.meta.env.MODE,
});

if (secrets.sentryDsn) {
  init({
    dsn: secrets.sentryDsn,
    environment: secrets.environment,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    tracesSampleRate: secrets.environment === "production" ? 0.1 : 1,
    integrations: [browserTracingIntegration()],
    beforeSend: createSentryBeforeSend({ surface: "marketing" }),
  } as unknown as Parameters<typeof init>[0]);
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
