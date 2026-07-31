# Web Event identity contract

Web Events are App/Environment browser telemetry facts used for exploratory web analytics. They are
not Exposures, Activations, or Metric Events and never become an Experiment Run's analysis
denominator or Metric input.

**Implementation status:** specified, not implemented. Web Event intake must use the ADR-0043
Admission Gate, durable outbox, and queue transport when built.

Browser code submits manual Web Events through `sdk.web.track()`. Automatic browser instrumentation
uses the same `POST /api/sdk/web-events` Event Ingest Worker route. Top-level `sdk.track()` remains
exclusively for Metric Events on `POST /api/sdk/events`, and neither accessor nor route infers an
Event Definition family.

The first manual `sdk.web.track()` call activates manual delivery and creates or reads the default
Web Session. Automatic instrumentation is configured separately through `sdk.web.instrument()`;
its first emitted event creates or reads the same Web Session path. There is no generic Web
Analytics enable step.

## Web Session

Every Web Event belongs to exactly one Web Session and carries a required `sessionId`. The Web
Session is a bounded browser activity scope, not an Entity, Targeting Key, Experiment Run, or Entity
Profile.

By default, the browser SDK generates a cryptographically random UUID v4 `sessionId` and stores it
in `sessionStorage`. The identifier survives reloads and same-tab navigation and ends when the
browser tab closes. The SDK does not use cookies, `localStorage`, browser fingerprinting, or a
cross-site or cross-device identifier.

An application may explicitly supply an opaque Web Session identifier when it needs consent-aware
cross-tab or cross-domain continuity through
`createSplitchClient({ clientKey, web: { sessionId } })`. A supplied identifier must use the same
canonical lowercase UUID shape and is validated during client construction; arbitrary strings are
rejected before instrumentation, a claim, or a write. There is no setter or per-event override. The
SDK never discovers or imports an identifier from application cookies or storage automatically.

All events in one Web Session carry the same logical identifier and events from different Web
Sessions do not stitch. The session source, SDK-generated or application-supplied, does not change
the exploratory-only boundary.

The Event Ingest Worker never persists the wire `sessionId`. After validation, it computes
`session_id_hash` with the App's stable secret identity key, domain-separated by `web-session` and
the authenticated Environment, and uses only that pseudonym in the durable outbox, queue, Tinybird
row, logs, and read APIs. Routine secret rotation preserves the underlying identity key, so one
retained Web Session does not split during rotation. The raw identifier exists only while validating
and canonicalizing the request.

## Event retry identity

Every Web Event wire request carries a required `eventId`. The browser SDK generates one
cryptographically random UUID per logical `sdk.web.track()` call or automatic event and reuses it
across buffering, batch assembly, transport retries, and page-lifecycle flushes. Application code
cannot supply or override this value through `sdk.web.track()`.

The Event Ingest Worker scopes a claim to `(web, app_id, environment_id, event_id)` and fingerprints
the complete canonical caller-supplied event content. The fingerprint excludes the
`event_definition_version_id`, which the Worker resolves. Therefore:

- an exact retry returns a `202` batch item with `status: "duplicate"` and the originally accepted
  Event Definition and Version and appends no second logical row;
- reusing an `eventId` for different event content returns `409 EVENT_ID_CONFLICT` and writes
  nothing;
- a Web Event claim cannot collide with a Metric Event claim carrying the same `eventId`.

At-least-once Tinybird delivery may still create duplicate physical rows. The family-scoped claim
and datasource dedup key represent one logical Web Event.

Transport batching does not change this scope. Every flush uses the `{ events: [...] }` envelope,
including a one-event flush, and every item retains its own `eventId`, fingerprint, claim, and
logical duplicate result.

After batch-level authentication and structural validation pass, each item is validated and claimed
independently. An invalid sibling writes nothing but does not block a valid item. The ordered batch
response identifies every accepted, duplicate, or rejected item by `eventId`.

The browser retains retry IDs and pending Web Event payloads only in memory. It never persists them
to IndexedDB, `localStorage`, `sessionStorage`, cookies, or another browser store. A page crash or
termination may therefore lose an event that ingest has not accepted; a later page load does not
retry or reconstruct it.

## Capture provenance and trace correlation

Every Web Event carries a stable `captureSource` and `sdkVersion`. Manual `sdk.web.track()` calls are
stamped `manual`; automatic adapters use their registered source key, beginning with `page_view`,
`web_vital`, and `browser_error`. The public SDK accessors do not allow application code to override
these fields. A direct Client Key HTTP caller can still submit any supported value, so capture
provenance is validated advisory telemetry, not authenticated evidence. These fields are not Event
Definition fields and cannot supply identity. `sdkVersion` is limited to the bounded SemVer shape in
[leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md), so it cannot carry arbitrary text.

A Web Event may also carry `traceId` and `spanId` as an optional pair. The Event Ingest Worker
accepts only non-zero lowercase W3C shapes: 32 hexadecimal characters for `traceId` and 16 for
`spanId`. These values permit correlation with an external trace store. Splitch does not use them to
stitch Web Sessions, infer Entities, or reconstruct and store an OpenTelemetry span tree.

At Web Event creation, the browser SDK reads the active span through the public
`@opentelemetry/api`. It stamps the pair only when the active span context is valid. A missing
provider, missing active span, or invalid no-op context leaves both fields absent and does not block
the Web Event. Splitch does not initialize tracing or create a span.

Event-specific OpenTelemetry values remain ordinary schema-governed `fields` or `dimensions`.
Resource attributes, instrumentation scope, span status, duration, and arbitrary attributes do not
become an undeclared metadata map.

## Optional Entity identity

A Web Event may carry explicit Entity identity:

```typescript
{
  sessionId: string;
  targetingKey?: string;
  idType?: string;
}
```

`targetingKey` and `idType` are optional as a pair. Supplying only one fails strict validation
before any claim or append. The credential supplies App and Environment; callers cannot override
either scope.

The accepting `web` Event Definition Version controls whether the pair is allowed. When its
`entityType` is null, any supplied identity is rejected with `ENTITY_TYPE_MISMATCH`. When
`entityType` is non-null, identity remains optional per event, but a supplied `idType` must match
exactly. This lets one definition accept pre-identity and post-identity facts without allowing
multiple Entity types or silently accepting identity on an anonymous-only definition.

Web Events emitted before identity becomes available remain anonymous. Later events in the same Web
Session may carry explicit Entity identity, and exploratory journey queries may display those facts
as one session sequence. Splitch does not rewrite earlier rows, promote them into Entity facts, or
create an Entity Profile.

## Query-time Web Session association

Exploratory analysis derives one association state for each
`(app_id, environment_id, session_id_hash)`:

- no distinct non-null `(id_type, targeting_key_hash)` pair: the Web Session is anonymous;
- exactly one distinct pair: the Web Session is associated with that Entity for exploratory journey
  grouping;
- more than one distinct pair: the Web Session is an Ambiguous Web Session and is attributed to no
  Entity.

Association is a query-time projection over retained Web Events. It does not update an earlier
anonymous row, fill its nullable identity columns, or create a durable Entity Profile. An identified
event remains an identified fact; an anonymous event remains an anonymous fact even when both appear
in one associated journey.

`Ambiguous Web Session` is distinct from the `__multiple__` sentinel, which is reserved for
conflicting Experiment Variants within one Run. An ambiguous journey is an exploratory identity
boundary, not an Experiment health row, and cannot be resolved by first identity, last identity, or
majority identity.

## Experiment boundary

Web Session correlation never creates an Assignment, Exposure, Activation, or Metric Event.
Experiment analysis joins only explicit Entity-identified Metric Events to the first-touch Exposure
set using App, Environment, Entity type, and Targeting Key hash. It never joins through
`sessionIdHash` or infers Entity identity from Web Session membership.

An App may deliberately use a session as an Experiment's Targeting Key. In that case the session is
an Entity because the Experiment explicitly declares it as the randomization unit, not because a
Web Session exists.

## Sources

- [metric-event-contract.md](./metric-event-contract.md)
- [web-analytics-capture.md](../sdk/web-analytics-capture.md)
- [leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md)
- [privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [ADR-0041](../../adr/0041-splitch-does-not-store-entity-profiles.md)
