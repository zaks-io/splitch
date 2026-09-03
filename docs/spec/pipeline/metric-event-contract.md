# Metric Event contract

Metric Events are App/Environment/Entity product facts used as Metric inputs. They are not
Exposures, Activations, or Web Events, and they never become an Experiment Run's analysis
denominator.

**Implementation status:** specified, not implemented. When implemented, this route must use the
ADR-0043 durable queue transport and must not copy the current direct Tinybird append helper.

## SDK surface and route

The public JS/TS SDK exposes one stateless call:

```typescript
sdk.track(eventName, {
  targetingKey,
  idType,
  eventId,
  fields,
  dimensions,
});
```

This top-level accessor is Metric Event-only. It never accepts or dispatches Web Event payloads;
browser telemetry uses the separate [`sdk.web.track()`](../sdk/web-analytics-capture.md) accessor.
The SDK does not infer Event Definition family from payload shape or a server lookup.

It sends a strict `MetricEventTrackRequest` to `POST /api/sdk/events` on the Event Ingest Worker.
The request carries no App, Environment, Targeting Key hash, Event Definition ID, or Event Definition
Version. The authenticated SDK credential supplies App and Environment. The Worker resolves the
`metric` Event Definition by `eventName`, hashes the Targeting Key, and stamps the currently
published version.

`targetingKey`, `idType`, and caller-stable UUID `eventId` are required on every call. The event ID
must use the canonical lowercase UUID shape; arbitrary business identifiers and direct identifiers
are invalid. V1 has no stateful `identify()` API and no Entity Profile payload. A top-level
`attributes`, `traits`, `profile`, `eventDefinitionId`, or `eventDefinitionVersionId` field is an
unknown field and fails strict request validation before any write.

The complete UTF-8 encoded JSON request body may not exceed 32 KiB (32,768 bytes). The Event Ingest
Worker checks bytes before Event Definition lookup, admission, claim creation, or outbox sealing.
This bound also guarantees that the canonical row can fit inside the Queue-safe delivery envelope
defined by [edge-ingest-contract.md](./edge-ingest-contract.md).

## Credential boundary

Both SDK credential classes may call the route:

- A Client Key has a narrow write-only `track` capability in addition to `evaluate`. It cannot read
  Event Definitions, Metric Events, Metrics, or configuration.
- An API Key may call `track` through its existing `data-plane:write` capability.

The Evaluation Worker resolves `app_id` and `environment_id` from the validated credential and
enforces the Client Key origin/referrer allow-list in `data-plane-auth.ts`. Its shared registrar then
applies the per-credential Cloudflare Workers Rate Limiting binding before delegating the request to
Event Ingest. A request cannot override either scope. The live Cloudflare Free WAF rule covers only
exact path `/agent/identity`; broader paid WAF enforcement remains deferred under ADR-0034.

New canonical Metric Event rows must also pass the aggregate Ingest Admission Gate for
`(app_id, environment_id, metric_events)`, charged by row count and serialized queue-payload bytes.
An exact idempotent retry consumes no new aggregate capacity. Gate exhaustion returns
`429 RATE_LIMITED` before a new claim, outbox write, or queue publication.
Concurrent attempts that both precede the winning claim may conservatively consume capacity more
than once, as defined by [edge-ingest-contract.md](./edge-ingest-contract.md), but still produce one
logical Metric Event.

## Validation and no-write ordering

The Evaluation and Event Ingest Workers perform these steps in order:

1. The Evaluation Worker validates the credential, resolves one App and Environment, and rejects a
   disallowed Client Key origin in `data-plane-auth.ts`.
2. The shared registrar applies the per-credential Cloudflare Workers Rate Limiting binding and returns
   `429 RATE_LIMITED` when the budget is exhausted.
3. The Evaluation Worker delegates the authorized request to Event Ingest.
4. Event Ingest revalidates the delegated credential and its App and Environment scope before
   accepting the request.
5. Event Ingest performs bounded body reading and strict Zod parsing. Oversized bodies, unknown
   top-level fields, and malformed values are rejected.
6. Event Ingest applies its per-credential Durable Object rate limiter. Exhaustion returns
   `429 RATE_LIMITED`; an unavailable or invalid limiter response fails closed with
   `503 SERVICE_UNAVAILABLE`.
7. The Event Ingest Worker derives `targeting_key_hash` with the active identity epoch's immutable
   `app_entity_identity_key` and builds the stable request fingerprint (see Idempotency). Routine
   key-encryption rotation does not change the derived hash. The fingerprint intentionally excludes
   `event_definition_version_id` so retries survive a later publish.
8. The Event Ingest Worker looks up any existing `(metric, app_id, environment_id, event_id)` idempotency claim:
   - Exact fingerprint match returns `202 { duplicate: true }` and writes nothing further. A
     trusted API Key response includes the originally accepted `eventDefinitionId` /
     `eventDefinitionVersionId`. A Client Key response omits those internal IDs. Current published
     version validation is not re-applied.
   - A different fingerprint returns `409 EVENT_ID_CONFLICT` and writes nothing.
   - No claim continues.
9. The Worker resolves `eventName` to the App-level Event Definition, requires `family = "metric"`,
   and resolves its current published Event Definition Version. A `web` definition with the same
   requested name is not a Metric Event contract and fails before any claim or append. The client
   cannot select a version or family.
10. `idType` must equal the published version's `entityType`.
11. The complete `fields` and `dimensions` objects are validated against that version. Unknown field
    names, unknown Dimensions, missing required values, type mismatches, schemaless JSON, unknown
    nested JSON keys, and string values outside definition-time machine-token allowlists fail. Metric
    Events have no free-form string or direct-PII payload path.
12. The Worker charges one new canonical row and its serialized queue-payload bytes through the
    Ingest Admission Gate for `(app_id, environment_id, metric_events)`. Rejection returns
    `429 RATE_LIMITED` before any new claim, outbox write, or queue publication.
13. The Worker atomically seals the family-scoped claim, stable fingerprint, accepted immutable
    version id, and complete canonical `metric_events` delivery payload in the sharded durable
    ingest outbox.
14. The outbox publishes the row to the `metric_events` queue until successful. The request handler
    never posts the row directly to Tinybird; the queue consumer includes it in a
    datasource-specific NDJSON microbatch.

Within Event Ingest, steps 4 and 5 are side-effect free. Step 6 may increment only the
per-credential Durable Object rate-limit counter, and step 12 may update only aggregate Admission
Gate state. A failure through step 12 writes no idempotency claim, outbox row, queue message, or
Tinybird row. Step 13 is one atomic durable acceptance boundary, so a committed claim cannot exist without its
canonical delivery payload. `202` may return after that seal and does not wait for queue publication
or Tinybird commit.

## Idempotency

`eventId` identifies one logical Metric Event and must be reused for every retry of that fact.

```text
dedup_key = sha256("metric:" + app_id + ":" + environment_id + ":" + event_id)
payload_fingerprint = sha256(canonical_json(
  event_name,
  id_type,
  targeting_key_hash,
  fields,
  dimensions
))
```

`payload_fingerprint` excludes `event_definition_version_id`. Callers cannot select a version, so an
exact retry must remain idempotent even when a new Event Definition Version was published between
attempts.

- A first claim validates against the current published version, passes aggregate admission,
  atomically seals the fingerprint, accepted version id, and canonical delivery payload in the
  outbox, and returns `duplicate: false`.
- A retry with the same key and fingerprint is idempotent and returns `duplicate: true` with the
  originally accepted version; it does not re-validate against the current published version and
  does not append a second logical row.
- An exact retry whose only change is that the current Targeting Key hash/version advanced still
  matches if the stored fingerprint equals the payload hashed under any retained identity epoch.
- Reusing the key with a fingerprint that matches no retained epoch returns `409 EVENT_ID_CONFLICT`
  and writes nothing.

At-least-once queue and Tinybird delivery may still produce duplicate physical rows. Tinybird does
not enforce `dedup_key` uniqueness. Every Metric query reads the aggregate-state
`serve_deduped_metric_events` logical source, which yields exactly one row per `dedup_key` before
field extraction, Conversion Window filtering, Entity aggregation, or Ratio operand formation. No
statistical aggregate may read physical `metric_events` rows directly.

## Response

Successful first delivery and idempotent retry both return `202`:

```typescript
{
  accepted: true;
  duplicate: boolean;
  eventId: string;
  eventDefinitionId?: string;
  eventDefinitionVersionId?: string;
}
```

A trusted API Key response includes `eventDefinitionId` and `eventDefinitionVersionId` so the
caller can prove which immutable Event Definition Version accepted the event. A Client Key
response omits both IDs. The public SDK `track()` projection never returns them. The response
never returns the raw Targeting Key or its hash.

`activate()` returns `409 ACTIVATION_NOT_AVAILABLE` without `Retry-After` when the Metric Event
cannot activate a matching Experiment Run. Under a Client Key, unpublished Activation configuration,
no binding for the Event Definition, an incompatible Entity type, and no Exposure-backed Assignment
all use the same message and empty details so the response cannot identify an Entity's enrollment.
An API Key receives the same code with a message naming the permanent failed condition. Infrastructure
and integrity failures remain `503 SERVICE_UNAVAILABLE` with `Retry-After`.

## Accepted row

The canonical accepted row is defined in
[leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md#accepted-metric-event-row). The
physical Tinybird mapping is
[storage-schemas-tinybird.md](../contracts/storage-schemas-tinybird.md#metric_events-metric-event-log).
Every row stores both `event_definition_id` and `event_definition_version_id`.

## Analysis compatibility

A Metric references an App-level Event Definition in the `metric` family and, when it consumes a
value, a declared named typed field. It never stores an ad hoc JSON path.

The Analysis Worker reads the bounded aggregate-state Metric Event relation defined in
[physical-datasources.md](./physical-datasources.md#metric-retry-state-deduped_metric_events_state),
which performs the mandatory `argMinMerge` retry collapse before returning canonical rows.

A Metric Event can join an Experiment Run only when all of these match:

- `app_id`
- `environment_id`
- `id_type = Run.targeting_key_type`
- `targeting_key_hash`
- the Metric's referenced Event Definition and field contract
- `server_received_at >= window_anchor`
- either the effective `conversion_window_ms` is `0` (unbounded), or
  `server_received_at < window_anchor + conversion_window_ms`

The control plane rejects attaching an incompatible Metric to an Experiment or starting a Run with
one using `ENTITY_TYPE_MISMATCH`; the failed mutation writes nothing. The Analysis Worker repeats
the equality predicate at query time and fails loud if persisted configuration violates it.

Metric Events supply numerators and values only. The first-touch Exposure set remains the complete
analysis denominator, including Exposed Entities with no matching Metric Event.

## Retention, privacy, and Web Events

`metric_events` is a separate append-only datasource with the same default 90-day replay retention
as `raw_events`. Retention must cover every promised Conversion Window and analysis replay window.
Entity export/delete and App deletion include Metric Event rows by `app_id`, `id_type`, and
`targeting_key_hash`; the raw Targeting Key is never stored.

Web Events are a separate event family and datasource. This route does not accept browser page,
click, or DOM telemetry and does not add a Web Event discriminator to `metric_events`.

## Sources

- [leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md)
- [error-responses.md](../contracts/error-responses.md)
- [edge-ingest-contract.md](./edge-ingest-contract.md)
- [privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [metric-types.md](../stats/metric-types.md)
- [ADR-0043](../../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md)
