# Deterministic query-key factory: shape, hierarchy, and nudge-to-invalidation mapping

## Why a factory

TanStack Query invalidation only works if every key that represents the same data is byte-identical.
A nudge arriving from the WebSocket (`{ entity: 'experiment', id: expId }`) must map to an exact
set of cache key prefixes to invalidate. That mapping must be **one module, one source of truth**;
hand-assembled key arrays in components or loaders break the guarantee.

The factory lives in the panel app (`apps/panel/lib/query-keys.ts`), not in `packages/ui` or
`packages/contracts`. It is domain-aware and has one consumer (panel), so it stays in the panel.
If a second consumer needs it the deletion test is re-evaluated.

## Spine: appId at index 1

Every key in the factory MUST start with `['app', appId, ...]`. This invariant enables:
- **Prefix invalidation** by App: `invalidateQueries({ queryKey: ['app', appId] })` clears all of one App's cache
- **App-switch purge**: `invalidateQueries({ queryKey: ['app', previousAppId] })` on appId change
- **Isolation**: queries for App A can never accidentally serve App B

## Key hierarchy

```
['app', appId]                                        // App root (prefix only)
['app', appId, 'experiment']                          // list prefix
['app', appId, 'experiment', 'list']                  // list result
['app', appId, 'experiment', expId]                   // detail prefix
['app', appId, 'experiment', expId, 'detail']         // full detail
['app', appId, 'experiment', expId, 'run']            // runs list for experiment
['app', appId, 'experiment', expId, 'run', runId]     // single run detail
['app', appId, 'flag']                                // flag list prefix
['app', appId, 'flag', 'list']                        // flag list result
['app', appId, 'flag', flagId]                        // flag detail prefix
['app', appId, 'flag', flagId, 'detail']              // flag detail
['app', appId, 'metric']                              // metric list prefix
['app', appId, 'metric', 'list']                      // metric list result
['app', appId, 'metric', metricId, 'detail']          // metric detail
['app', appId, 'segment']                             // segment list prefix
['app', appId, 'segment', 'list']                     // segment list result
['app', appId, 'segment', segmentId, 'detail']        // segment detail
['app', appId, 'variant']                             // variant list prefix (per flag)
['app', appId, 'variant', flagId, 'list']             // variants for a flag
```

## Factory interface (pseudo-signature)

```
keys = {
  app: {
    root:  (appId: string) => ['app', appId]
  },
  experiment: {
    list:   (appId: string) => ['app', appId, 'experiment', 'list']
    prefix: (appId: string) => ['app', appId, 'experiment']
    detail: (appId: string, expId: string) => ['app', appId, 'experiment', expId, 'detail']
    runs:   (appId: string, expId: string) => ['app', appId, 'experiment', expId, 'run']
    run:    (appId: string, expId: string, runId: string)
            => ['app', appId, 'experiment', expId, 'run', runId]
  },
  flag: {
    list:    (appId: string) => ['app', appId, 'flag', 'list']
    prefix:  (appId: string) => ['app', appId, 'flag']
    detail:  (appId: string, flagId: string) => ['app', appId, 'flag', flagId, 'detail']
    variants:(appId: string, flagId: string) => ['app', appId, 'variant', flagId, 'list']
  },
  metric: {
    list:   (appId: string) => ['app', appId, 'metric', 'list']
    prefix: (appId: string) => ['app', appId, 'metric']
    detail: (appId: string, metricId: string) => ['app', appId, 'metric', metricId, 'detail']
  },
  segment: {
    list:   (appId: string) => ['app', appId, 'segment', 'list']
    prefix: (appId: string) => ['app', appId, 'segment']
    detail: (appId: string, segId: string) => ['app', appId, 'segment', segId, 'detail']
  },
}
```

## Nudge-to-invalidation mapping

When the WebSocket delivers `NudgePayload { type, entity, id, version }`, the handler:

1. Checks version gate: if `queryClient.getQueryData(keys[entity].detail(appId, id))?.version >= nudge.version`, skip (no-op for the editor who just wrote).
2. Calls `queryClient.invalidateQueries({ queryKey: keys[entity].prefix(appId) })`.

This single prefix call invalidates the list, detail, runs, and all sub-resources for the entity in
one operation — no enumeration of individual keys.

Mapping table (nudge entity → invalidated prefix):
| nudge `entity`   | prefix invalidated                              |
|------------------|-------------------------------------------------|
| `experiment`     | `keys.experiment.prefix(appId)`                 |
| `flag`           | `keys.flag.prefix(appId)`                       |
| `metric`         | `keys.metric.prefix(appId)`                     |
| `segment`        | `keys.segment.prefix(appId)`                    |

## Version gating (no double-refetch for the editor)

The mutation 200 response carries `{ version: number }`. The editor stores this in the Query cache
as part of the refetch it triggers after 200 (see [mutation-data-flow.md](./mutation-data-flow.md)).
When the echoed nudge arrives, the cached version is already equal to the nudge's version, so the
version-gate skips the redundant refetch. Other editors have older cached versions, so they refetch.

## Failure contract

The factory is a **pure, total function** over its string inputs — it performs no I/O and cannot
fail at runtime. There is no success-vs-error superposition because there is no error path: every
builder returns a key array unconditionally. Malformed usage is caught at compile time:

- A missing or wrong-typed argument (e.g. omitting `appId`) is a TypeScript error, not a runtime one.
- A nudge whose `entity` is not a known key in `keys` is rejected at the handler boundary: the
  nudge handler **must** narrow `nudge.entity` against the known entity union before calling
  `keys[entity].prefix(appId)`. An unrecognized entity is logged and dropped (fail-loud, no silent
  no-op and no invalidation of an unintended prefix), never passed to the factory.
- Invalidation itself (`queryClient.invalidateQueries`) is owned by TanStack Query, not this module;
  its failure handling lives in [websocket-lifecycle.md](./websocket-lifecycle.md) (stale data is
  kept, a dismissable toast shown, bounded retry).

## Invariants

- No component or loader constructs a key array by hand. All keys come from this factory.
- The factory is the only import site for cache keys in the panel app.
- `appId` is always at index 1 of every key; any key without it is a bug.

## Sources

- [ADR-0019](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
