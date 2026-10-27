# Deterministic query-key factory: shape, hierarchy, and nudge-to-invalidation mapping

## Why a factory

TanStack Query invalidation only works if every key that represents the same data is byte-identical.
A nudge arriving from the WebSocket (`{ entity: 'experiment', id: expId }`) must map to an exact
set of cache key prefixes to invalidate. That mapping must be **one module, one source of truth**;
hand-assembled key arrays in components or loaders break the guarantee.

The factory lives in the Control Panel app (`apps/control-panel/src/lib/shared/query-keys.ts`), not in
`packages/ui` or `packages/contracts`. It is domain-aware and has one consumer (Control Panel), so it
stays in the Control Panel app.
If a second consumer needs it the deletion test is re-evaluated.

## Spine: (appId, environmentId) at the root

Every Environment-scoped domain key in the factory starts with `['app', appId, 'env', environmentId, ...]`. This invariant
enables:

- **Prefix invalidation** by (App, Environment): `invalidateQueries({ queryKey: ['app', appId, 'env', environmentId] })` marks matching cached queries stale and refetches active queries
- **App/Environment-switch invalidation**: `invalidateQueries({ queryKey: ['app', previousAppId, 'env', previousEnvironmentId] })` on `(appId, environmentId)` change
- **Isolation**: queries for App A can never accidentally serve App B, and dev's cache can never serve prod

Other scopes have their own roots: `queryKeys.app.settings(appId)` returns
`['app', appId, 'settings']`, and `queryKeys.org.sentryInstallations(orgId)` returns
`['org', orgId, 'sentry-installations']`. Session-resolution keys use URL handles under
`['session', 'scope', orgSlug, appSlug, env, ...]`, because IDs are not resolved yet;
`scopedSessionQuery` sets `staleTime: 0` so cached resolution never grants access.

## Key hierarchy

Environment-scoped keys below exist in the factory, except Web Analytics, whose keys and routes
remain specified work. The factory also provides Environment settings, Exposure status, Convex and
Cloudflare installation keys, and an Experiment Run `results` suffix.

```
['app', appId, 'env', envId]                                        // App+Environment root (prefix only)
['app', appId, 'env', envId, 'experiment']                          // list prefix
['app', appId, 'env', envId, 'experiment', 'list']                  // list result
['app', appId, 'env', envId, 'experiment', expId]                   // detail prefix
['app', appId, 'env', envId, 'experiment', expId, 'detail']         // full detail
['app', appId, 'env', envId, 'experiment', expId, 'run']            // runs list for experiment
['app', appId, 'env', envId, 'experiment', expId, 'run', runId]     // single run detail
['app', appId, 'env', envId, 'flag']                                // flag list prefix
['app', appId, 'env', envId, 'flag', 'list']                        // flag list result
['app', appId, 'env', envId, 'flag', flagId]                        // flag detail prefix
['app', appId, 'env', envId, 'flag', flagId, 'detail']              // flag detail
['app', appId, 'env', envId, 'metric']                              // metric list prefix
['app', appId, 'env', envId, 'metric', 'list']                      // metric list result
['app', appId, 'env', envId, 'metric', metricId, 'detail']          // metric detail
['app', appId, 'env', envId, 'segment']                             // segment list prefix
['app', appId, 'env', envId, 'segment', 'list']                     // segment list result
['app', appId, 'env', envId, 'segment', segmentId, 'detail']        // segment detail
['app', appId, 'env', envId, 'variant']                             // variant list prefix (per flag)
['app', appId, 'env', envId, 'variant', flagId, 'list']             // variants for a flag
['app', appId, 'env', envId, 'web-analytics']                       // Web Analytics prefix
['app', appId, 'env', envId, 'web-analytics', 'overview', window]   // overview aggregate
['app', appId, 'env', envId, 'web-analytics', 'sessions', filters]  // session summaries
['app', appId, 'env', envId, 'web-analytics', 'session', sessionIdHash, window] // session events
['app', appId, 'env', envId, 'web-analytics', 'vitals', window]     // Web Vitals aggregate
```

## Factory interface (Environment-scoped subset, pseudo-signature)

```
queryKeys = {
  app: {
    root:  (appId: string, envId: string) => ['app', appId, 'env', envId]
  },
  experiment: {
    list:   (appId: string, envId: string) => ['app', appId, 'env', envId, 'experiment', 'list']
    prefix: (appId: string, envId: string) => ['app', appId, 'env', envId, 'experiment']
    detail: (appId: string, envId: string, expId: string) => ['app', appId, 'env', envId, 'experiment', expId, 'detail']
    runs:   (appId: string, envId: string, expId: string) => ['app', appId, 'env', envId, 'experiment', expId, 'run']
    run:    (appId: string, envId: string, expId: string, runId: string)
            => ['app', appId, 'env', envId, 'experiment', expId, 'run', runId]
  },
  flag: {
    list:    (appId: string, envId: string) => ['app', appId, 'env', envId, 'flag', 'list']
    prefix:  (appId: string, envId: string) => ['app', appId, 'env', envId, 'flag']
    detail:  (appId: string, envId: string, flagId: string) => ['app', appId, 'env', envId, 'flag', flagId, 'detail']
    variants:(appId: string, envId: string, flagId: string) => ['app', appId, 'env', envId, 'variant', flagId, 'list']
  },
  metric: {
    list:   (appId: string, envId: string) => ['app', appId, 'env', envId, 'metric', 'list']
    prefix: (appId: string, envId: string) => ['app', appId, 'env', envId, 'metric']
    detail: (appId: string, envId: string, metricId: string) => ['app', appId, 'env', envId, 'metric', metricId, 'detail']
  },
  segment: {
    list:   (appId: string, envId: string) => ['app', appId, 'env', envId, 'segment', 'list']
    prefix: (appId: string, envId: string) => ['app', appId, 'env', envId, 'segment']
    detail: (appId: string, envId: string, segId: string) => ['app', appId, 'env', envId, 'segment', segId, 'detail']
  },
  webAnalytics: {
    prefix:   (appId: string, envId: string) => ['app', appId, 'env', envId, 'web-analytics']
    overview: (appId: string, envId: string, from: string, to: string, interval: 'hour' | 'day')
              => ['app', appId, 'env', envId, 'web-analytics', 'overview', { from, to, interval }]
    sessions: (appId: string, envId: string, from: string, to: string, eventName: string | null, association: string | null, limit: number)
              => ['app', appId, 'env', envId, 'web-analytics', 'sessions', { from, to, eventName, association, limit }]
    sessionEvents: (appId: string, envId: string, sessionIdHash: string, from: string, to: string, limit: number)
                   => ['app', appId, 'env', envId, 'web-analytics', 'session', sessionIdHash, { from, to, limit }]
    vitals:   (appId: string, envId: string, from: string, to: string)
              => ['app', appId, 'env', envId, 'web-analytics', 'vitals', { from, to }]
  },
}
```

## Nudge-to-invalidation mapping

When the WebSocket delivers `DeltaNudge { type, entity, id, version, deleted? }`, the handler:

1. Checks the version gate for non-deletion nudges when the entity has a directly addressable cached detail. A `run` nudge skips this optimization because the canonical payload does not carry its parent Experiment ID.
2. Calls `queryClient.invalidateQueries({ queryKey: nudgeInvalidationPrefix[entity](appId, environmentId) })`.

This single prefix call invalidates the mapped list, detail, and sub-resources in one operation. No
individual keys are enumerated.

Mapping table (nudge entity → invalidated prefix):

| nudge `entity` | prefix invalidated                                  |
| -------------- | --------------------------------------------------- |
| `experiment`   | `queryKeys.experiment.prefix(appId, environmentId)` |
| `flag`         | `queryKeys.flag.prefix(appId, environmentId)`       |
| `run`          | `queryKeys.experiment.prefix(appId, environmentId)` |
| `segment`      | `queryKeys.segment.prefix(appId, environmentId)`    |

`run` invalidates the Environment's Experiment prefix because the canonical nudge carries a Run ID,
not its parent Experiment ID. The subsequent read remains the source of truth; the client does not
maintain a Run-to-Experiment index.

## Version gating (skip an echo when the cache is current)

Versioned resource responses carry `version`. A successful reread can put that version in the
Query cache (see [mutation-data-flow.md](./mutation-data-flow.md)). Route-loader-only writes do not
synthesize a cached version, so their echoed nudge may still refetch.
When an echoed Flag, Experiment, or Segment nudge arrives, a cached version equal to the nudge's
version skips the redundant refetch. Other editors have older cached versions, so they refetch. Run
nudges always refetch the Experiment prefix because the payload cannot address a Run detail key by
itself.

## Failure contract

The factory is a **pure, total function** over its string inputs — it performs no I/O and cannot
fail at runtime. There is no success-vs-error superposition because there is no error path: every
builder returns a key array unconditionally. Malformed usage is caught at compile time:

- A missing or wrong-typed argument (e.g. omitting `appId` or `environmentId`) is a TypeScript error, not a runtime one.
- A nudge whose `entity` is outside the canonical contract union is rejected by the strict payload
  schema before it reaches the mapping. The mapping is compile-time total over that union.
- Invalidation itself (`queryClient.invalidateQueries`) is owned by TanStack Query, not this module;
  its failure handling lives in [websocket-lifecycle.md](./websocket-lifecycle.md) (stale data is
  kept, a dismissable toast shown, bounded retry).

## Invariants

- No component or loader constructs a key array by hand. All keys come from this factory.
- The factory is the only import site for cache keys in the Control Panel app.
- Environment-scoped domain keys place `appId` at index 1 and `environmentId` at index 3.
  App settings, Organization integrations, and session resolution use the separate roots above.
- Web Analytics keys include the complete normalized time window, route-specific filters, and
  pagination limit. Cursor pages belong to the corresponding infinite query and never create
  hand-authored component keys.
- Web Event ingest produces no WebSocket nudge and Web Analytics queries have no polling interval.
  Refresh invalidates the current complete key. Latest creates a new key only after replacing the
  URL's `from` and `to` with a duration-preserving window ending at the current UTC instant.

## Sources

- [ADR-0019](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
