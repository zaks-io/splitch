# Frontend spec index

**Spine idea:** `(appId, environmentId)` resolved from the URL (`/{orgSlug}/{appSlug}/{env}/...`, ADR-0027)
drives four otherwise-independent mechanisms — isolation check, query-cache root, live-update DO, and
socket lifecycle — ensuring they can never disagree. The panel
is TanStack Start on a Cloudflare Worker; the marketing site is a second TanStack Start Worker;
both share one `ui` package and the `contracts` package.

## Files

| file                                    | one-line purpose                                                               |
|-----------------------------------------|--------------------------------------------------------------------------------|
| [appid-is-the-spine.md](./appid-is-the-spine.md) | The spine concept: four jobs driven by one URL param, and why not session state |
| [session-loader-isolation.md](./session-loader-isolation.md) | Cookie format, KV validation, loader context shape, membership check, 403 contract |
| [query-key-factory.md](./query-key-factory.md) | Deterministic cache-key hierarchy, factory interface, nudge-to-invalidation mapping |
| [websocket-lifecycle.md](./websocket-lifecycle.md) | Socket ownership, attachment timing, reconnect semantics, nudge payload, retry policy |
| [mutation-data-flow.md](./mutation-data-flow.md) | Server-confirmed writes, no optimistic updates, error response shape, form error surfacing |
| [error-loading-tiers.md](./error-loading-tiers.md) | Three error boundary tiers, loading/pending UI, Sentry severity by tier |
| [observability-pii-scrubbing.md](./observability-pii-scrubbing.md) | Sentry context, distributed tracing, PII scrubbing field paths, Axiom log rules |
| [package-boundaries-ui-component-layer.md](./package-boundaries-ui-component-layer.md) | Three-tier package split, deletion-test results, token ownership, component placement rules |

## Source ADRs

- [ADR-0017](../../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md) — stack + monorepo
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md) — D1/KV identity, app_id isolation
- [ADR-0019](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md) — WebSocket, nudge, Query store
- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md) — TanStack Start, two Workers, shared `ui`
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md) — Environment is a first-class axis under App; three-segment URL spine

## Key Invariants

- **WorkOS session issuer** — WorkOS is the session issuer (AuthKit + SSO/SCIM); the cookie seam is issuer-agnostic
- **No optimistic writes** — cache updates happen only via refetch after server 200
- **(appId, environmentId) from URL only** — resolved from `/{orgSlug}/{appSlug}/{env}`; no "current app/environment" in session or React context
- **Branding guide location** — `docs/branding/design-tokens.md` (to be created by design; token names pinned in `packages/ui/src/theme.css`, values deferred)
