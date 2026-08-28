/**
 * Single lazy handle on `@sentry/cloudflare`, and the single place tests swap it.
 *
 * Lazy because the module is only reachable once `SENTRY_DSN` is set; a static
 * import would pull the SDK into every Worker bundle including local dev and the
 * e2e fleet, which never emit. Shared because a second loader would mean a second
 * `__setSentryModuleForTests` and a test that overrides one while production code
 * reads the other -- a false green with no visible cause.
 */

export type SentryCloudflare = typeof import("@sentry/cloudflare");

let sentryModule: SentryCloudflare | undefined;
let sentryModuleOverride: SentryCloudflare | undefined;

/** @internal Injects a Sentry client for unit tests. */
export function __setSentryModuleForTests(module: SentryCloudflare | undefined): void {
  sentryModuleOverride = module;
  sentryModule = module;
}

export async function loadSentry(): Promise<SentryCloudflare> {
  if (sentryModuleOverride) {
    return sentryModuleOverride;
  }
  sentryModule ??= await import("@sentry/cloudflare");
  return sentryModule;
}
