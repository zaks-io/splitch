# Metric Event contract

Metric Events are App/Environment/Entity product facts used as Metric inputs. They are not
Exposures, Activations, or Web Events, and they never become an Experiment Run's analysis
denominator.

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

It sends a strict `MetricEventTrackRequest` to `POST /api/sdk/events` on the Event Ingest Worker.
The request carries no App, Environment, Targeting Key hash, Event Definition ID, or Event Definition
Version. The authenticated SDK credential supplies App and Environment. The Worker resolves the
Event Definition by `eventName`, hashes the Targeting Key, and stamps the currently published
version.

`targetingKey`, `idType`, and caller-stable `eventId` are required on every call. V1 has no stateful
`identify()` API and no Entity Profile payload. A top-level `attributes`, `traits`, `profile`,
`eventDefinitionId`, or `eventDefinitionVersionId` field is an unknown field and fails strict
request validation before any write.

## Credential boundary

Both SDK credential classes may call the route:

- A Client Key has a narrow write-only `track` capability in addition to `evaluate`. It cannot read
  Event Definitions, Metric Events, Metrics, or configuration.
- An API Key may call `track` through its existing `data-plane:write` capability.

The Event Ingest Worker resolves `app_id` and `environment_id` from the validated credential. A
request cannot override either scope. Client Key requests pass the same origin/referrer allow-list
and per-key rate limit as evaluation requests before Worker dispatch.

## Validation and no-write ordering

The Worker performs these steps in order:

1. Cloudflare rejects a disallowed origin or exceeded rate limit.
2. Credential validation resolves one App and Environment or rejects the request.
3. Strict Zod parsing rejects unknown top-level fields and malformed values.
4. The Worker derives `targeting_key_hash` with the active App privacy salt and builds the stable
   request fingerprint (see Idempotency). The fingerprint intentionally excludes
   `event_definition_version_id` so retries survive a later publish.
5. The Worker looks up any existing `(app_id, environment_id, event_id)` idempotency claim:
   - Exact fingerprint match returns `202 { duplicate: true }` with the originally accepted
     `eventDefinitionId` / `eventDefinitionVersionId` and writes nothing further. Current published
     version validation is not re-applied.
   - A different fingerprint returns `409 EVENT_ID_CONFLICT` and writes nothing.
   - No claim continues.
6. The Worker resolves `eventName` to the App-level Event Definition and its current published
   Event Definition Version. The client cannot select a version.
7. `idType` must equal the published version's `entityType`.
8. The complete `fields` and `dimensions` objects are validated against that version. Unknown field
   names, unknown Dimensions, missing required values, type mismatches, schemaless JSON, and unknown
   nested JSON keys fail.
9. The Worker claims `(app_id, environment_id, event_id)` with the stable fingerprint and the
   accepted immutable version id in the sharded ingest idempotency seam.
10. The accepted immutable version and server-owned scope fields are stamped onto one
    `metric_events` row and appended to Tinybird.

Steps 1 through 8 are side-effect free until a new claim is committed. A failure at any of those
steps writes no idempotency claim and no Tinybird row. An idempotency claim is committed only for a
fully valid canonical payload (or is already present for an exact retry).

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

- A first claim validates against the current published version, stores the fingerprint plus the
  accepted version id, appends the row, and returns `duplicate: false`.
- A retry with the same key and fingerprint is idempotent and returns `duplicate: true` with the
  originally accepted version; it does not re-validate against the current published version and
  does not append a second logical row.
- Reusing the key with a different fingerprint returns `409 EVENT_ID_CONFLICT` and writes nothing.

At-least-once Tinybird delivery may still produce duplicate physical rows. `dedup_key` is the
datasource idempotency key, so consumers observe one logical Metric Event.

## Response

Successful first delivery and idempotent retry both return `202`:

```typescript
{
  accepted: true;
  duplicate: boolean;
  eventId: string;
  eventDefinitionId: string;
  eventDefinitionVersionId: string;
}
```

The response proves which immutable Event Definition Version accepted the event. It never returns
the raw Targeting Key or its hash.

## Accepted row

The canonical accepted row is defined in
[leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md#accepted-metric-event-row). The
physical Tinybird mapping is
[storage-schemas-tinybird.md](../contracts/storage-schemas-tinybird.md#metric_events-metric-event-log).
Every row stores both `event_definition_id` and `event_definition_version_id`.

## Analysis compatibility

A Metric references an App-level Event Definition and, when it consumes a value, a declared named
typed field. It never stores an ad hoc JSON path.

A Metric Event can join an Experiment Run only when all of these match:

- `app_id`
- `environment_id`
- `id_type = Run.targeting_key_type`
- `targeting_key_hash`
- the Metric's referenced Event Definition and field contract

The control plane rejects attaching an incompatible Metric to an Experiment or starting a Run with
one using `ENTITY_TYPE_MISMATCH`; the failed mutation writes nothing. The Analysis Worker repeats
the equality predicate at query time and fails loud if persisted configuration violates it.

Metric Events supply numerators and values only. The first-touch Exposure set remains the complete
analysis denominator, including Exposed Entities with no matching Metric Event.

## Retention, privacy, and future Web Events

`metric_events` is a separate append-only datasource with the same default 90-day replay retention
as `raw_events`. Retention must cover every promised Conversion Window and analysis replay window.
Entity export/delete and App deletion include Metric Event rows by `app_id`, `id_type`, and
`targeting_key_hash`; the raw Targeting Key is never stored.

Web Events are a separate future event family and future datasource. V1 does not accept browser
page, click, or DOM telemetry through this route and does not add a Web Event discriminator to
`metric_events`.

## Sources

- [leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md)
- [error-responses.md](../contracts/error-responses.md)
- [edge-ingest-contract.md](./edge-ingest-contract.md)
- [privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [metric-types.md](../stats/metric-types.md)
