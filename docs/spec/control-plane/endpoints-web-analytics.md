# Web Analytics read endpoints

The Analysis Worker serves three purpose-built Web Analytics surfaces over retained `web_events`:
overview, sessions, and Web Vitals. The sessions surface uses separate collection and event-detail
routes so neither response requires unbounded nesting. These are authenticated control-plane
operations scoped to one App and Environment. The Worker injects `app_id` and `environment_id` from
the validated path and auth context; callers never supply Tinybird scope or credentials.

**Implementation status:** specified, not implemented. These reads depend on the unimplemented
`web_events` ingest path and ADR-0043 queue transport.

All four routes across the three surfaces are authored once as Zod-first contracts in
`@splitch/contracts` and consumed through `@splitch/control-plane-sdk`. The panel, CLI, and MCP
server are presentation skins over those same operations.

All App roles, `owner`, `admin`, and `member`, may read these endpoints under the existing **View
config/results** permission. They require a control-plane bearer or a least-privilege delegated
Analysis credential. Client Keys and API Keys cannot read Web Analytics.

## Shared time window

Every route requires the same strict query:

```typescript
{
  from: string; // inclusive UTC timestamp
  to: string; // exclusive UTC timestamp
}
```

Both values use the canonical timestamp format: ISO 8601 UTC with millisecond precision
(`YYYY-MM-DDTHH:mm:ss.sssZ`). The Analysis Worker filters on `server_received_at`, not client or
ingest time. It requires `from < to` and a span of at most 30 days.

Malformed timestamps, a reversed or empty window, and a span over 30 days return
`400 VALIDATION_ERROR` with issue paths identifying `from` or `to`. If `from` predates the current
retention floor computed from the Environment's configured Web Event TTL, the Worker returns
`410 WEB_ANALYTICS_WINDOW_UNAVAILABLE` with that floor. The floor is independent of the earliest
retained event, so a valid interval before an App's first Web Event returns an empty result rather
than `410`. The Worker never clamps, widens, or substitutes a default window.

Panel presets and CLI presentation conveniences must resolve to concrete `from` and `to` values
before calling the shared typed operation. MCP callers send the same explicit timestamps.

## Routes

### `GET /apps/{appId}/envs/{environmentId}/web-analytics/overview`

Returns bounded aggregate Web Event and Web Session totals plus event-name breakdowns for the
requested time window.

Operation ID: `web_analytics_overview_get`.

The route adds one required query field to the shared window:

```typescript
{
  interval: "hour" | "day";
}
```

Its response is:

```typescript
{
  window: {
    from: string;
    to: string;
    interval: "hour" | "day";
  }
  totals: {
    eventCount: number;
    sessionCount: number;
    anonymousSessionCount: number;
    associatedSessionCount: number;
    ambiguousSessionCount: number;
    associatedEntityCount: number;
  }
  buckets: Array<{
    from: string;
    to: string;
    eventCount: number;
    sessionCount: number;
  }>;
  events: Array<{
    eventDefinitionId: string;
    eventName: string;
    eventCount: number;
    sessionCount: number;
  }>;
}
```

Counts operate on one logical Web Event per `dedup_key`, never physical retry rows.
`sessionCount` counts Web Sessions with at least one retained event inside the requested window.
Session association is derived over all retained rows in that App, Environment, and Web Session,
even when only part of the journey is inside the requested window:

- `anonymousSessionCount`, `associatedSessionCount`, and `ambiguousSessionCount` are mutually
  exclusive and sum to `sessionCount`;
- `associatedEntityCount` counts distinct Entity type and Targeting Key hash pairs across associated
  sessions and never includes ambiguous sessions.

Buckets begin exactly at the requested `from`, advance by one UTC hour or 24-hour day, and truncate
the final bucket at `to`. The Worker returns every bucket, including zero-valued buckets. A Web
Session with events in multiple buckets counts once in each relevant bucket, so bucket
`sessionCount` values do not necessarily sum to the window total.

The `events` array groups across Event Definition Versions by stable `eventDefinitionId` and
`eventName`, ordered by `eventCount` descending and then `eventName` ascending. It returns no event
field or Dimension values.

### `GET /apps/{appId}/envs/{environmentId}/web-analytics/sessions`

Returns cursor-paginated Web Session summaries. It never inlines a session's event collection.
Session association is derived according to
[web-event-identity.md](../pipeline/web-event-identity.md).

Operation ID: `web_analytics_sessions_list`.

The route composes the shared time window and pagination query with only these optional filters:

```typescript
{
  eventName?: string;
  association?: "anonymous" | "associated" | "ambiguous";
  limit?: number;
  cursor?: string;
}
```

`eventName` is an exact stable Event Definition name. It selects sessions containing at least one
logical event with that name inside the requested window. `association` selects the query-derived
Web Session association state. Unknown query fields fail strict validation.

The response is `PaginatedResponse<WebSessionSummary>` with `total: null`:

```typescript
type WebSessionSummary = {
  sessionIdHash: string;
  firstEventAt: string;
  lastEventAt: string;
  firstEventName: string;
  lastEventName: string;
  eventCount: number;
  association: "anonymous" | "associated" | "ambiguous";
  entity: {
    idType: string;
    targetingKeyHash: string;
  } | null;
};
```

The first and last event values and `eventCount` describe all logical events in the session inside
the requested window, not only the event that matched `eventName`. `entity` is present only for an
associated session and is null for anonymous and ambiguous sessions. The raw Targeting Key is never
returned.

Sessions are ordered by `lastEventAt` descending and then `sessionIdHash` ascending. The cursor
preserves that order and is scoped to the exact window, filters, and limit. Summary rows contain no
event fields or Dimensions.

### `GET /apps/{appId}/envs/{environmentId}/web-analytics/sessions/{sessionIdHash}/events`

Returns one Web Session's cursor-paginated events in canonical journey order. It never truncates a
journey into the session summary or returns an unbounded nested collection.

Operation ID: `web_analytics_session_events_list`.

The route returns `404 WEB_SESSION_NOT_FOUND` when `sessionIdHash` is unknown, belongs outside the
authorized App and Environment, or has no logical event inside the requested window. These cases
share one empty detail shape, so the endpoint never reveals whether the identifier exists outside
the caller's scope or window.

The query composes the shared time window with standard `limit` and `cursor` pagination. Its response
is `PaginatedResponse<WebSessionEvent>` with `total: null`:

```typescript
type WebSessionEvent = {
  eventId: string;
  eventDefinitionId: string;
  eventDefinitionVersionId: string;
  eventName: string;
  sessionIdHash: string;
  sessionAssociation: "anonymous" | "associated" | "ambiguous";
  sessionEntity: {
    idType: string;
    targetingKeyHash: string;
  } | null;
  captureSource: string;
  sdkVersion: string;
  trace: {
    traceId: string;
    spanId: string;
  } | null;
  entity: {
    idType: string;
    targetingKeyHash: string;
  } | null;
  fields: Record<string, JsonValue>;
  dimensions: Record<string, boolean | string | number>;
  serverReceivedAt: string;
};
```

Each item is one logical Web Event after `dedup_key` deduplication. `sessionAssociation` and
`sessionEntity` repeat on every item so each cursor page is self-describing. `sessionEntity` is
present only for an associated session. `entity` describes only the explicit identity on that Web
Event, so an anonymous event remains null even inside an associated session. `trace` is either the
complete validated pair or null.

Events are ordered by `serverReceivedAt` ascending and then `eventId` ascending. The response never
returns `dedupKey`, `ingestTs`, a raw Targeting Key, or another Tinybird storage field.

### `GET /apps/{appId}/envs/{environmentId}/web-analytics/vitals`

Returns aggregate Web Vitals from Web Events captured by the built-in `web_vital` adapter.

Operation ID: `web_analytics_vitals_get`.

The Worker includes only logical events reporting the validated `captureSource = web_vital`. The
source distinguishes normal SDK-generated samples from `sdk.web.track()` calls, but a direct Client
Key HTTP caller can report the same supported value. Web Vitals is therefore exploratory client
telemetry, not authenticated provenance or an Experiment input. The response is:

```typescript
{
  window: {
    from: string;
    to: string;
  }
  percentileMethod: "tdigest";
  groups: Array<{
    eventDefinitionId: string;
    eventName: string;
    metricName: "CLS" | "FCP" | "INP" | "LCP" | "TTFB";
    unit: "milliseconds" | "unitless";
    navigationType:
      | "navigate"
      | "reload"
      | "back_forward"
      | "back_forward_cache"
      | "prerender"
      | "restore"
      | "unknown";
    sampleCount: number;
    sessionCount: number;
    p50: number;
    p75: number;
    p95: number;
    ratingCounts: {
      good: number;
      needsImprovement: number;
      poor: number;
    };
  }>;
}
```

Each group is one `(eventDefinitionId, eventName, metricName, unit, navigationType)` tuple.
Percentiles use the adapter's cumulative `fields.value`; `fields.delta` is not a percentile input.
`sampleCount` counts logical Web Events and `sessionCount` counts distinct Web Sessions.
`ratingCounts` maps the adapter's `good`, `needs-improvement`, and `poor` values, and the three counts
sum to `sampleCount`.

The Tinybird pipe computes all three percentiles in one
`quantilesTDigest(0.5, 0.75, 0.95)(value)` aggregation. `percentileMethod: "tdigest"` makes the
memory-efficient approximation explicit; counts remain exact.

Only nonempty groups are returned. They are ordered by `eventName`, `metricName`, and
`navigationType`, all ascending. The endpoint returns no event-level payload, Web Session identifier,
Entity identity, trace context, or Dimension map.

## Tinybird query contract

Each endpoint first builds a bounded logical window row set:

1. read `serve_deduped_web_events` with injected `app_id`, `environment_id`, partition-date bounds,
   inclusive `server_received_at >= from`, and exclusive `server_received_at < to`; it filters the
   state datasource before `argMinMerge` and returns one logical row per `dedup_key`;
2. apply endpoint-specific fixed filters, such as `capture_source = 'web_vital'`, in the same first
   node;
3. select only columns needed by the endpoint;
4. perform JSON extraction, grouping, percentile calculation, ordering, and pagination only after
   the filtered logical row set exists.

Overview, session collection, and session-event detail derive Web Session association in a second
bounded stage. They take only the candidate `session_id_hash` values present in the logical window
row set, then read all retained `serve_deduped_web_events` rows for those sessions under the same
injected `app_id` and `environment_id`. That association stage counts distinct non-null Entity pairs
across the retained session history. Out-of-window rows may change
only the session's association state; they never enter requested-window totals, event counts,
journey ordering, or response payloads. The Web Vitals route does not perform session association.

Pipes use typed Tinybird parameters, never concatenate SQL, and expose no caller-authored expression.
They do not use `SELECT *`, scan another App or Environment, apply `FINAL`, or join an unfiltered
event datasource. The association stage is restricted to the candidate session set before reading
retained history. Fixed adapter JSON properties are extracted only after source and time filtering.

Materialized rollups, projections, PREWHERE changes, and data-skipping indexes are evidence-driven
optimizations, not alternate response contracts. The implementation records `pipe_stats_rt`
latency, rows read, bytes read, memory, and errors and inspects `?explain=true`. It introduces a
materialized serving projection when aggregation p95 exceeds 5 seconds or memory exceeds 60%, and
revisits the sorting key or adds skipping indexes when rows read exceed rows returned by 100 times
and p95 exceeds 3 seconds. Optimization must preserve the typed API shapes and logical dedup rules
above.

## Boundary

- Web Analytics reads are exploratory and never return or alter Experiment results.
- Tinybird remains private behind the Analysis Worker.
- V1 exposes no arbitrary SQL, generic Tinybird query proxy, caller-authored expression language, or
  funnel builder.
- Empty windows return successful zero or empty responses from overview, sessions collection, and
  vitals. Session-event detail is the sole exception and returns `WEB_SESSION_NOT_FOUND`.
- Raw Targeting Keys and Event Definition authoring metadata are never returned.
- Query results derive only from retained, accepted Web Event rows and never rewrite those rows.
- A cursor is scoped to the exact `from` and `to` values that created it.
- Session collection pagination and one session's event pagination use separate cursors.

## Sources

- [endpoints-test-eval-analytics.md](./endpoints-test-eval-analytics.md)
- [web-event-identity.md](../pipeline/web-event-identity.md)
- [storage-schemas-tinybird.md](../contracts/storage-schemas-tinybird.md)
- [system-architecture.md](../../architecture/system-architecture.md)
- [Tinybird aggregate functions](https://www.tinybird.co/docs/sql-reference/functions/aggregate-functions)
