import { initControlPanelSentry } from "./panel-observability";

type ClientSentryImportEnv = {
  MODE: string;
  VITE_SENTRY_DSN?: string;
  VITE_SENTRY_RELEASE?: string;
  VITE_SPLITCH_PLATFORM_TARGET?: string;
};

let started = false;

export async function initControlPanelClientSentry(): Promise<void> {
  if (started || typeof window === "undefined") {
    return;
  }
  started = true;
  const Sentry = await import("@sentry/react");
  initControlPanelSentry(clientSentryEnv(import.meta.env), {
    addBreadcrumb: (breadcrumb) => {
      Sentry.addBreadcrumb(breadcrumb);
    },
    captureException: (error, context) => {
      Sentry.captureException(error, context);
    },
    init: (options) => {
      Sentry.init({
        ...options,
        integrations: [Sentry.browserTracingIntegration()],
      } as unknown as Parameters<typeof Sentry.init>[0]);
    },
    setTag: (key, value) => {
      Sentry.setTag(key, value);
    },
    setUser: (user) => {
      Sentry.setUser(user);
    },
  });
}

export function clientSentryEnv(env: ClientSentryImportEnv) {
  return {
    SENTRY_DSN: env.VITE_SENTRY_DSN,
    SENTRY_RELEASE: env.VITE_SENTRY_RELEASE,
    SPLITCH_PLATFORM_TARGET: env.VITE_SPLITCH_PLATFORM_TARGET ?? env.MODE,
  };
}
