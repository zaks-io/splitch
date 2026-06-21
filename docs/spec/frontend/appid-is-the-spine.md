# appId is the spine: four jobs, one URL param

## The spine concept

Everything in the panel keys off a single value: the **active App's `appId`**, carried in the URL
as `/app/:appId/...`. Because all four mechanisms read from the same source, they cannot disagree
with each other — there is no ambient "current app" state to drift.

This is an architectural spine, not a convention. Violating it (e.g. persisting `currentAppId` in
a React context or session) reintroduces the possibility of the four mechanisms diverging.

## The four jobs

### 1. Isolation check

The route loader under `/app/:appId/` validates the session's membership against `:appId` before
doing any work. A mismatch returns 403. This is the application-enforced `app_id` boundary of
ADR-0018, made visible and auditable at the loader seam.

The check is mandatory, not optional. Every loader at or below the `/app/:appId/` layout must call
`requireAppAccess(ctx, appId)` or delegate to a parent loader that did.

See [session-loader-isolation.md](./session-loader-isolation.md) for the full contract.

### 2. Query-cache root

Every TanStack Query key in the panel starts with `['app', appId, ...]`. This ensures:

- App A's cache can never serve App B (wrong `appId` at index 1 → cache miss, not contamination)
- Logout or App switch can purge the entire App's cache with one `invalidateQueries` call by prefix
- Nudge invalidation is scoped to the correct App without enumeration

The query-key factory enforces this invariant. No component or loader assembles a key by hand.

See [query-key-factory.md](./query-key-factory.md) for the full contract.

### 3. Live-update DO identity

The per-App fan-out Durable Object is named `idFromName(appId)`. The WebSocket at `/app/:appId/`
connects to exactly this DO. The `appId` in the URL drives the socket target.

Consequence: a socket connected to the wrong DO receives nudges for the wrong App. Because the
socket is owned by the `/app/:appId` layout route, and that route's `appId` comes from the URL,
the socket and the DO are always in sync by construction.

See [websocket-lifecycle.md](./websocket-lifecycle.md) for the full contract.

### 4. Socket lifecycle

The socket's mount/unmount is driven by `appId`. When `appId` changes (navigation from App A to
App B), the layout effect:
1. Closes the socket connected to `DO(A)`
2. Purges the cache for App A: `invalidateQueries({ queryKey: ['app', 'A'] })`
3. Opens a new socket to `DO(B)`
4. Triggers full invalidate-and-refetch for App B

The socket's lifetime is the same as the `/app/:appId` layout route's lifetime. It never outlives
its owning `appId`.

## Why URL over session state

| Approach                    | Problem                                          |
|-----------------------------|--------------------------------------------------|
| `currentAppId` in session   | Server and client can drift; not bookmarkable    |
| `currentAppId` in React ctx | Context can outlive navigation; cache contamination risk |
| `appId` from URL (chosen)   | Isolation boundary is visible at every loader; shareable; no ambient state to drift |

The URL is the only state that is simultaneously visible to the SSR loader (server) and the
client. Persisting "current app" anywhere else creates a second source of truth.

## No appId in session cookie

The session cookie carries `userId`, `orgId`, `memberships` (all Apps the user can access), and
`orgRole`. It does NOT carry a "current app" pointer. The active App is always the URL param.

Switching apps is a navigation (`<Link to="/app/newAppId/...">`), not a state mutation.

## Sources

- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0019](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
