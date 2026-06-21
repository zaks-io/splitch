# appId is the spine: four jobs, one URL param

## The spine concept

Everything in the panel keys off values carried in the URL: the **active App's `appId`** and the
**active `environment_id`**, in the URL as `/{orgSlug}/{appSlug}/{env}/...`. Because all mechanisms
read from the same source, they cannot disagree — there is no ambient "current app" or "current
environment" state to drift.

This is an architectural spine, not a convention. Violating it (e.g. persisting `currentAppId` or a
"current environment" in a React context or session) reintroduces the possibility of the mechanisms
diverging.

**Scope resolution.** `orgSlug` and `appSlug` are human/agent-readable URL handles only (ADR-0027 /
navigation-and-ia.md). The panel Worker resolves `orgSlug → orgId` and `appSlug → appId` once, at the
loader seam; every mechanism below speaks IDs (`appId`, `environment_id`). Slugs never key a cache,
a DO, or a data lookup. The `env` segment resolves to `environment_id` the same way.

**Environment is a co-spine.** Per-Environment data (Flag Configuration, experiments, Exposures,
credentials — ADR-0027) means the active Environment joins `appId` in keying the four mechanisms below:
the isolation check, the cache root, and the live-update DO/socket are all scoped by
`(appId, environment_id)`, not `appId` alone.

## The four jobs

### 1. Isolation check

The route loaders under `/{orgSlug}/{appSlug}/{env}/` resolve the slugs to IDs and validate the
session's membership (`requireOrgAccess` then `requireAppAccess`) before doing any work. A mismatch
returns 403; an `appId` not belonging to the `orgSlug` returns 404. This is the application-enforced
`app_id` boundary of ADR-0018, made visible and auditable at the loader seam.

The check is mandatory, not optional. Every loader at or below the `/{orgSlug}/{appSlug}/{env}` layout
must call `requireOrgAccess`/`requireAppAccess` or delegate to a parent loader that did.

See [session-loader-isolation.md](./session-loader-isolation.md) for the full contract.

### 2. Query-cache root

Every TanStack Query key in the panel starts with `['app', appId, 'env', environmentId, ...]`. This
ensures:

- App A's cache can never serve App B, and dev's cache can never serve prod (wrong `appId` or
  `environmentId` in the prefix → cache miss, not contamination)
- Logout, App switch, or Environment switch can purge the relevant cache with one `invalidateQueries`
  call by prefix
- Nudge invalidation is scoped to the correct App + Environment without enumeration

The query-key factory enforces this invariant. No component or loader assembles a key by hand.

See [query-key-factory.md](./query-key-factory.md) for the full contract.

### 3. Live-update DO identity

The per-App-per-Environment fan-out Durable Object is named `idFromName(`${appId}:${environmentId}`)`.
The WebSocket at `/{orgSlug}/{appSlug}/{env}/` connects to exactly this DO. The resolved `appId` +
`environment_id` drive the socket target. (Nudges are Environment-specific — a prod flag change must
not invalidate a dev view — so the DO is keyed by the pair, not by `appId` alone.)

Consequence: a socket connected to the wrong DO receives nudges for the wrong App or Environment.
Because the socket is owned by the `/{appSlug}/{env}` layout route, and that route's IDs come from the
URL, the socket and the DO are always in sync by construction.

See [websocket-lifecycle.md](./websocket-lifecycle.md) for the full contract.

### 4. Socket lifecycle

The socket's mount/unmount is driven by `(appId, environmentId)`. When either changes (App switch or
Environment switch), the layout effect:
1. Closes the socket connected to `DO(prev)`
2. Purges the cache for the previous scope: `invalidateQueries({ queryKey: ['app', appId, 'env', envId] })`
3. Opens a new socket to `DO(next)`
4. Triggers full invalidate-and-refetch for the new scope

The socket's lifetime is the same as the `/{appSlug}/{env}` layout route's lifetime. It never outlives
its owning `(appId, environmentId)`.

## Why URL over session state

| Approach                    | Problem                                          |
|-----------------------------|--------------------------------------------------|
| `currentAppId` in session   | Server and client can drift; not bookmarkable    |
| `currentAppId` in React ctx | Context can outlive navigation; cache contamination risk |
| `appId` from URL (chosen)   | Isolation boundary is visible at every loader; shareable; no ambient state to drift |

The URL is the only state that is simultaneously visible to the SSR loader (server) and the
client. Persisting "current app" anywhere else creates a second source of truth.

## No appId or environment in the session cookie

The session cookie carries `userId`, `memberships` (every Org and App the user can access, across all
their Orgs), and roles. It does NOT carry a "current app," "current org," or "current environment"
pointer. The active Org, App, and Environment are always URL segments (a user may belong to multiple
Orgs — the org switcher changes `orgSlug`, it does not mutate a cookie). See
[navigation-and-ia.md](./navigation-and-ia.md) and [session-loader-isolation.md](./session-loader-isolation.md).

Switching App or Environment is a navigation (`<Link to="/{orgSlug}/{appSlug}/{env}/...">`), not a
state mutation.

## Sources

- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0019](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
