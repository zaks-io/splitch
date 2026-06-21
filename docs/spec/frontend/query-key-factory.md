# Deterministic query-key factory: shape, hierarchy, and nudge-to-invalidation mapping

## Why a factory

TanStack Query invalidation only works if every key that represents the same data is byte-identical.
A nudge arriving from the WebSocket (`{ entity: 'experiment', id: expId }`) must map to an exact
set of cache key prefixes to invalidate. That mapping must be **one module, one source of truth**;
hand-assembled key arrays in components or loaders break the guarantee.

The factory lives in the Control Panel app (`apps/control-panel/lib/query-keys.ts`), not in
`packages/ui` or `packages/contracts`. It is domain-aware and has one consumer (Control Panel), so it
stays in the Control Panel app.
If a second consumer needs it the deletion test is re-evaluated.

## Spine: (appId, environmentId) at the root

Every key in the factory MUST start with `['app', appId, 'env', environmentId, ...]`. This invariant
enables:

- **Prefix invalidation** by (App, Environment): `invalidateQueries({ queryKey: ['app', appId, 'env', environmentId] })` clears all of one App+Environment's cache
- **App/Environment-switch purge**: `invalidateQueries({ queryKey: ['app', previousAppId, 'env', previousEnvironmentId] })` on `(appId, environmentId)` change
- **Isolation**: queries for App A can never accidentally serve App B, and dev's cache can never serve prod

## Key hierarchy

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
```

## Factory interface (pseudo-signature)

```
keys = {
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
}
```

## Nudge-to-invalidation mapping

When the WebSocket delivers `NudgePayload { type, entity, id, version }`, the handler:

1. Checks version gate: if `queryClient.getQueryData(keys[entity].detail(appId, environmentId, id))?.version >= nudge.version`, skip (no-op for the editor who just wrote).
2. Calls `queryClient.invalidateQueries({ queryKey: keys[entity].prefix(appId, environmentId) })`.

This single prefix call invalidates the list, detail, runs, and all sub-resources for the entity in
one operation — no enumeration of individual keys.

Mapping table (nudge entity → invalidated prefix):
| nudge `entity` | prefix invalidated |
|------------------|-------------------------------------------------|
| `experiment` | `keys.experiment.prefix(appId, environmentId)` |
| `flag` | `keys.flag.prefix(appId, environmentId)` |
| `metric` | `keys.metric.prefix(appId, environmentId)` |
| `segment` | `keys.segment.prefix(appId, environmentId)` |

## Version gating (no double-refetch for the editor)

The mutation 200 response carries `{ version: number }`. The editor stores this in the Query cache
as part of the refetch it triggers after 200 (see [mutation-data-flow.md](./mutation-data-flow.md)).
When the echoed nudge arrives, the cached version is already equal to the nudge's version, so the
version-gate skips the redundant refetch. Other editors have older cached versions, so they refetch.

## Failure contract

The factory is a **pure, total function** over its string inputs — it performs no I/O and cannot
fail at runtime. There is no success-vs-error superposition because there is no error path: every
builder returns a key array unconditionally. Malformed usage is caught at compile time:

- A missing or wrong-typed argument (e.g. omitting `appId` or `environmentId`) is a TypeScript error, not a runtime one.
- A nudge whose `entity` is not a known key in `keys` is rejected at the handler boundary: the
  nudge handler **must** narrow `nudge.entity` against the known entity union before calling
  `keys[entity].prefix(appId, environmentId)`. An unrecognized entity is logged and dropped (fail-loud, no silent
  no-op and no invalidation of an unintended prefix), never passed to the factory.
- Invalidation itself (`queryClient.invalidateQueries`) is owned by TanStack Query, not this module;
  its failure handling lives in [websocket-lifecycle.md](./websocket-lifecycle.md) (stale data is
  kept, a dismissable toast shown, bounded retry).

## Invariants

- No component or loader constructs a key array by hand. All keys come from this factory.
- The factory is the only import site for cache keys in the Control Panel app.
- `appId` is always at index 1 and `environmentId` at index 3 (after the `'env'` tag) of every key;
  any key without the `(appId, environmentId)` root is a bug.

## Sources

- [ADR-0019](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
