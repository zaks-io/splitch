# WebSocket connection ownership, lifecycle, reconnect semantics, and DO coordination

## Transport

**Hibernating WebSocket** via Cloudflare DO Hibernation API. Not SSE. The DO evicts from memory
while the socket is idle; the edge holds the socket open. Billing stops accruing during idle periods,
which is the decisive reason WebSocket beats SSE on this stack.

## Ownership: `/{orgSlug}/{appSlug}/{env}` layout route

One socket per browser tab per (App, Environment). The socket is **owned by the
`/{orgSlug}/{appSlug}/{env}` layout route** — the outermost layout that wraps all panel views for a
given App + Environment. It is the right owner because:

- It mounts once per (App, Environment) session and persists across child navigations (flags → experiments → runs)
- It tears down only when `(appId, environmentId)` changes (App switch or Environment switch) or the tab closes
- Its lifetime matches exactly the "one per (App, Environment)" fan-out DO grain

The socket is **never** owned by a child route, a Suspense boundary, or a context provider that
might re-mount. Ownership belongs to the layout root.

## Attachment point: client-only effect after hydration

The socket must not connect during SSR. The loader runs server-side with no socket; the socket
attaches in a `useEffect` (or TanStack Start's client-side lifecycle hook) at **layout mount on the
client**, after hydration is complete.

```
// pseudo-code — inside /{orgSlug}/{appSlug}/{env} layout, client-only
useEffect(() => {
  const ws = connectToEnv(appId, environmentId)   // idFromName(`${appId}:${environmentId}`) on the DO
  ws.onopen  = () => invalidateAndRefetch(appId, environmentId, queryClient)
  ws.onclose = () => scheduleReconnect()
  ws.onmessage = (e) => handleNudge(JSON.parse(e.data), appId, environmentId, queryClient)
  return () => ws.close()
}, [appId, environmentId])
```

## DO identity

The WebSocket connects to the fan-out DO whose name is the `(appId, environmentId)` pair. Nudges are
Environment-specific — a prod change must not invalidate a dev view — so the DO is keyed by the pair,
not by `appId` alone:

```
DO identity: idFromName(`${appId}:${environmentId}`)
URL pattern: wss://<panel-worker>/{orgSlug}/{appSlug}/{env}/live
```

The `(appId, environmentId)` resolved from the URL must match the App + Environment in the authenticated
session membership (the Worker enforces this before upgrading the connection). A socket cannot attach to a
DO it has no membership for.

## Connect and reconnect: full invalidate-and-refetch

On every `onopen` (initial connect **and** reconnect), the client:

```
queryClient.invalidateQueries({ queryKey: ['app', appId, 'env', environmentId] })
```

This closes the sub-second gap between the loader-seeded first paint and the socket connecting.
Any nudge missed in that window self-heals immediately on connect. There is no delta-replay log,
no last-seen-version bookkeeping, no `getSince(v)` API.

## (appId, environmentId) change: tear down and reconnect

When the resolved `(appId, environmentId)` changes — an App switch or an Environment switch, e.g.
navigating from `/{org}/A/dev/...` to `/{org}/B/dev/...` or `/{org}/A/dev/...` to `/{org}/A/prod/...`:

1. The layout effect cleanup closes the socket connected to `DO(prev)`
2. The old scope's cache is invalidated: `invalidateQueries({ queryKey: ['app', prevAppId, 'env', prevEnvId] })`
3. The effect re-runs with the new `(appId, environmentId)`, opening a new socket to `DO(next)`
4. The connect handler triggers `invalidateQueries({ queryKey: ['app', appId, 'env', environmentId] })` → full refetch

## Nudge payload shape

The DO broadcasts a small, schema-opaque signal. The panel consumes:

```
NudgePayload {
  type:    string    // e.g. 'config.changed'
  entity:  string    // 'experiment' | 'flag' | 'metric' | 'segment'
  id:      string    // entity ID
  version: number    // monotone counter on the entity
}
```

The DO never sends the config body. It sends only "something changed, go look."

## Nudge handler

```
function handleNudge(nudge: NudgePayload, appId: string, environmentId: string, qc: QueryClient) {
  const detail = qc.getQueryData(keys[nudge.entity].detail(appId, environmentId, nudge.id))
  if (detail?.version >= nudge.version) return           // version gate: no-op for editor
  qc.invalidateQueries({ queryKey: keys[nudge.entity].prefix(appId, environmentId) })
}
```

See [query-key-factory.md](./query-key-factory.md) for the full key mapping.

## Failure contract (Tier 3)

A failed nudge-triggered refetch is **non-fatal**:

- The failed refetch never unmounts existing data
- The UI degrades to stale + dismissable toast ("couldn't refresh, retrying")
- Retry policy: the initial refetch plus three retry attempts after 2 s / 4 s / 8 s with ±20% jitter
- After the third retry fails: stop retrying for that nudge; wait for the next nudge or manual refresh
- Sentry: low-severity breadcrumb, not an error event

Socket disconnection triggers the reconnect path (full invalidate-and-refetch), not the nudge retry
path. Disconnection is handled separately from per-nudge refetch failure.

## Source of truth

The socket is **never** the source of truth. It is a "something changed, go look" signal. The Query
cache refetch from the read API is the only mechanism that changes panel state.

## Marketing live-data routes

Marketing uses the same per-(App, Environment) DO (`idFromName(`${appId}:${environmentId}`)`) if it
fetches live config data (e.g. live pricing from a specific Environment's configuration). If a marketing
route is fully prerendered (static HTML at build time), it has no socket and needs none. Live-data
marketing routes follow the same nudge model;
the DO fans out to all connected clients across both Workers.

## Sources

- [ADR-0019](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
