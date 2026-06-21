# Error boundary placement, loading states, and failure handling semantics per layer

## Three fixed tiers

Error boundaries are placed at fixed levels of the route tree. The placement is not negotiable
per-route — it is a convention enforced by the panel app's routing config.

### Tier 1 — Root error boundary (app shell)

- **Location:** wraps the entire app shell (outside all routes)
- **Catches:** catastrophic and unexpected failures; anything that escapes Tier 2
- **Examples:** unhandled JS exceptions, missing required env bindings, boot-time failures
- **UI:** full-page "something broke" error page with a retry/reload option
- **Sentry:** reported as `error` severity with full stack trace, route context, userId, appId
- **Rule:** Tier 1 must NEVER trigger for expected domain states (403, 404, nudge failures)

### Tier 2 — Segment error boundaries (layout + major sections)

- **Location:** `/app/:appId` layout route AND each major section (Flags, Experiments, Settings)
- **Catches:** designed domain failures — 403 (no App access), 404 (resource not found),
  session expiry (redirect to login), App not found
- **Examples:**
  - User navigates to `/app/oldAppId/...` where they lost membership → 403
  - Experiment ID in URL no longer exists → 404
- **UI:** purpose-built empty states ("you don't have access to this App", "experiment not found")
  with a back-link; no stack trace, no Sentry error
- **Sentry:** breadcrumb only (`level: 'info'`). Not an error event. These are normal control flow.
- **Rule:** 403 and 404 MUST NOT generate Sentry error events. Logging them poisons the signal.

### Tier 3 — Background refetch failure (non-fatal)

- **Location:** the nudge handler's refetch error handler (not a React error boundary)
- **Catches:** failed Query refetches triggered by WebSocket nudges
- **Examples:** transient read API timeout, Cloudflare zone hiccup
- **UI:** stale data remains visible; dismissable toast appears ("couldn't refresh, retrying")
  The good data is NEVER unmounted. A failed refetch is always a degradation, never a crash.
- **Retry:** exponential backoff, 3 attempts (2 s / 4 s / 8 s ± 20% jitter), then stop
- **Sentry:** low-severity breadcrumb (`level: 'debug'`). A pattern of these (read API down)
  will surface as signal in Axiom; one blip is noise.
- **Rule:** failed background refetch MUST NOT unmount cached data or bubble to Tier 1/2

## Pending / loading UI

| Scenario                              | Loading treatment                                       |
|---------------------------------------|---------------------------------------------------------|
| First paint, loader-seeded route      | No spinner. Data is SSR'd into the Query cache.         |
| Client-side navigation to loaded route | No spinner. Query cache has the data already.           |
| Client-side navigation, data not loaded | `pendingComponent` shows skeleton from `ui` package.    |
| Suspense boundary (lazy component)    | `<Suspense fallback={<Skeleton />}>` from `ui` package  |
| Form submit in progress               | Submit button disabled + loading state (local useState) |

Skeletons are **brand components** living in `packages/ui`. The panel app uses them but does not
define them. There is one skeleton shape per major content type (list, detail card, data table).

## Error boundary visual components

Error page and empty-state visuals live in `packages/ui` (they are brand surfaces). The panel
app places them behind the appropriate boundary at the right tier. The `ui` package exports:

- `<AppErrorPage />` — Tier 1 (catastrophic)
- `<AccessDeniedPage />` — Tier 2 (403)
- `<NotFoundPage />` — Tier 2 (404)
- `<StaleDataToast />` — Tier 3 (non-fatal, nudge failure)

## Sentry severity summary

| Tier | Failure type               | Sentry level      |
|------|----------------------------|-------------------|
| 1    | Unexpected/catastrophic    | `error` (pages)   |
| 2    | 403 / 404 / domain failure | `info` breadcrumb |
| 3    | Background refetch failure | `debug` breadcrumb|

## Sources

- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
