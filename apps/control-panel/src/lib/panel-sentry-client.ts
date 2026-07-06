import { initControlPanelSentry } from "./panel-observability";

let started = false;

export async function initControlPanelClientSentry(): Promise<void> {
  if (started || typeof window === "undefined") {
    return;
  }
  started = true;
  const Sentry = await import("@sentry/react");
  initControlPanelSentry(
    {
      SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
      SENTRY_RELEASE: import.meta.env.VITE_SENTRY_RELEASE,
      SPLITCH_PLATFORM_TARGET: import.meta.env.MODE,
    },
    {
      addBreadcrumb: (breadcrumb) => {
        Sentry.addBreadcrumb(breadcrumb);
      },
      captureException: (error, context) => {
        Sentry.captureException(error, context);
      },
      init: (options) => {
        Sentry.init(options as unknown as Parameters<typeof Sentry.init>[0]);
      },
      setTag: (key, value) => {
        Sentry.setTag(key, value);
      },
      setUser: (user) => {
        Sentry.setUser(user);
      },
    },
  );
}
