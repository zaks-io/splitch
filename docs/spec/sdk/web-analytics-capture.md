# Web Analytics capture contract

Web Analytics emits explicitly submitted or instrumented Web Events for exploratory analysis. It is
not activated by creating a normal Splitch client and never contributes to Experiment measurement.

**Implementation status:** specified, not implemented. Web Event intake must be built on the
ADR-0043 durable queue transport and must not copy the current direct Tinybird append helper.

## Disabled by default

Until application code calls `sdk.web.track()` or `sdk.web.instrument()`, the SDK:

- does not create or read a Web Session;
- does not access `sessionStorage`;
- does not inspect the DOM or register DOM listeners;
- does not register browser performance or network instrumentation;
- does not patch browser APIs;
- does not emit Web Events.

Flag evaluation, Exposure collection, and Metric Event `track()` do not activate Web Analytics.
There is no generic `sdk.web.enable()` method.

## SDK namespace

Metric Events and Web Events have separate public accessors:

```typescript
const sdk = createSplitchClient({
  clientKey,
  web: {
    sessionId: consentAwareSessionId, // optional canonical UUID
  },
});

sdk.track(eventName, metricEvent);
sdk.web.track(eventName, webEvent);
const stop = sdk.web.instrument({ captures });
await sdk.web.flush();
stop();
```

Top-level `sdk.track()` is exclusively for Metric Events. `sdk.web.track()` is exclusively for Web
Events. Neither accessor infers the Event Definition family from payload shape or a server lookup,
and passing the wrong event shape fails strict validation.

Calling `sdk.web.track()` is sufficient to activate manual Web Event delivery. Its first call lazily
creates or reads the Web Session, creates the in-memory queue, and starts the queue lifecycle. It
does not require a prior enable or instrumentation call.

Manual `sdk.web.track()` calls and automatic browser instrumentation converge on the same Web Event
submission path. They receive the same family, schema, identity, idempotency, and credential
validation at ingest.

Application code does not pass an `eventId` to `sdk.web.track()`. The SDK generates one
cryptographically random UUID for each logical manual or automatic Web Event before buffering or
transport and retains that UUID across every retry.

The browser-only `web.sessionId` client option is the sole application-supplied Web Session entry
point. It is validated as a canonical lowercase UUID during client construction, retained in memory,
and used by both `sdk.web.track()` and `sdk.web.instrument()`. It has no setter, cannot be supplied
per event or capture entry, and does not activate Web Analytics. When omitted, the first emitted Web
Event creates or reads the default tab-scoped `sessionStorage` UUID.

## Route and family isolation

Manual and automatic Web Events submit to `POST /api/sdk/web-events` on the existing Event Ingest
Worker. Metric Events remain on `POST /api/sdk/events`. This adds no Worker or standalone analytics
service.

The Web Event route accepts only one strict batch envelope:

```typescript
{
  events: WebEventTrackRequest[];
}
```

The `events` array is non-empty. A one-event flush still sends a one-item array; the route does not
accept a bare Web Event or expose a second single-event format. `sdk.web.track()` always enqueues
first, and manual and automatic events may share one batch.

Each batch is limited to both:

- at most 25 Web Events;
- at most 32 KiB (32,768 bytes) for the complete UTF-8 encoded JSON request body.

The SDK flushes the current batch before adding an event that would cross either limit. If one
serialized Web Event cannot fit by itself inside the 32 KiB envelope, the SDK fails that event
locally through the strict validation path and performs no network request. The Event Ingest Worker
independently enforces both limits.

## Capture volume

V1 does not sample Web Events. The SDK produces every eligible event from each explicitly configured
automatic source and every explicit `sdk.web.track()` call. Neither the SDK nor the Event Ingest
Worker probabilistically samples, deterministically samples, thins, or silently drops eligible
events to manage volume.

The existing Client Key rate limit is a hard batch-level gate. When exceeded, the Event Ingest
Worker returns `429 RATE_LIMITED` with no claims or rows written. An explicit `web.flush()` rejects
through the canonical SDK error path, and a background flush emits the sanitized failure diagnostic.
The SDK never interprets a rate-limited batch as accepted.

The aggregate Ingest Admission Gate independently charges the count and serialized bytes of new
canonical Web Event rows under `(app_id, environment_id, web_events)`. When that batch-level gate is
exceeded, the complete SDK batch receives the same `429 RATE_LIMITED` no-write result. Exact
duplicate items consume no new admission capacity.
Concurrent attempts that both precede the winning family-scoped claim may conservatively consume
capacity more than once while still producing one logical Web Event.

Web Events consume zero V1 billing units. Their rate limit and batch bounds are operational abuse
and fairness controls, not plan quotas, spend guards, or a separate analytics meter.

The routes compose separate strict request schemas and have no caller-supplied Event family
discriminator. `/api/sdk/web-events` accepts only an Event Definition in the `web` family and
appends only to `web_events`; it never appends `raw_events` or `metric_events`. Any retry claim or
dedup key defined for a Web Event is namespaced to the `web` family and cannot collide with a Metric
Event claim.

The wire request requires the SDK-generated `eventId`. Direct HTTP clients must meet the same
requirement, but the public browser accessor does not expose an event ID parameter or override.
Idempotency remains per Web Event item rather than per batch.

## Per-item batch acceptance

Authentication, authorization, the per-credential rate limit, and the strict outer envelope are
batch-level gates. The outer envelope also requires every item to expose a valid UUID `eventId`, so
every result has a stable key. Failure at one of these gates rejects the entire request and writes no
claims or rows. More than 25 items or a UTF-8 request body larger than 32 KiB is an outer-envelope
`VALIDATION_ERROR`.

After those gates pass, the Event Ingest Worker independently performs side-effect-free schema
validation and existing-claim lookup for each item. Invalid items become ordered rejected results,
and exact retries become duplicate results. It then charges the aggregate row count and serialized
queue-payload bytes for all remaining new canonical items in one batch-level Admission Gate call.
Gate rejection returns `429 RATE_LIMITED` for the complete request before any new claim or outbox
write; it does not return partial item results.

After aggregate admission passes, the Worker independently seals each remaining valid item's
family-scoped claim and canonical delivery payload in the durable outbox. One schema-invalid item
does not block a valid sibling, but aggregate admission remains all-or-nothing for the request. A
structurally valid and admitted batch returns `202` with results in input order:

```typescript
{
  results: Array<
    | {
        eventId: string;
        status: "accepted" | "duplicate";
        eventDefinitionId?: string;
        eventDefinitionVersionId?: string;
      }
    | {
        eventId: string;
        status: "rejected";
        error: ErrorResponse;
      }
  >;
}
```

A trusted API Key accepted or duplicate item includes `eventDefinitionId` and
`eventDefinitionVersionId`. A Client Key response omits both IDs.

An accepted item has atomically committed its family-scoped claim and canonical payload to the
durable outbox for `web_events` delivery. A duplicate item was accepted previously and returns the
originally stamped Event Definition and Version. A rejected item commits no claim and appends no
row. The SDK removes accepted and duplicate items from memory, does not retry permanent validation
failures, and may retry retryable failures while the page remains alive.

The Event Ingest Worker does not translate this SDK batch into one Tinybird request per accepted
item. Accepted Web Event rows enter the shared durable ingest transport and are combined across SDK
requests into datasource-specific NDJSON microbatches as defined in
[edge-ingest-contract.md](../pipeline/edge-ingest-contract.md).

## Fail-loud delivery diagnostics

Web Event delivery uses the SDK's existing injectable `logger`; it does not add a Web Analytics
callback or hook system. Every permanent item rejection emits one `logger.error` call containing
only:

- `eventId`;
- `eventName`;
- `captureSource`;
- the canonical error code;
- schema issue paths, when present.

Every failed background timer or lifecycle batch emits one `logger.error` call containing only the
transport status or canonical error code and item count. An explicit `web.flush()` emits the same
sanitized logs while also returning ordered item results or rejecting on a batch-level failure.
Accepted and duplicate items emit no error log.

Diagnostics never include event fields or Dimensions, `sessionId`, Targeting Key, Targeting Key
hash, `idType`, `traceId`, `spanId`, request bodies, or response bodies. A retry is a new failed
delivery attempt and may produce its own one-per-attempt batch log; one attempt never logs the same
failure twice.

## In-memory queue and page lifecycle delivery

The Web Event queue exists only in memory.
The SDK never persists event bodies, generated `eventId` values, or retry state to IndexedDB,
`localStorage`, `sessionStorage`, cookies, or another browser store. `sessionStorage` is reserved for
the default Web Session identifier.

The SDK flushes at the earliest of:

1. five seconds after the first event enters an empty queue;
2. the current batch reaching 25 events or 32 KiB, or before adding an event that would cross either
   limit;
3. `document.visibilityState` changing to `hidden`;
4. `pagehide` as the lifecycle fallback.

The five-second timer starts only when an empty queue receives its first event and is cleared when
the queue becomes empty. There is no idle timer, heartbeat, or periodic network request. Queue flush
lifecycle listeners are registered only while the queue is non-empty and are removed when it
empties or the client is disposed.

Applications may call:

```typescript
const result: WebEventBatchResult = await sdk.web.flush();
```

`flush()` immediately snapshots and sends the currently queued events, then resolves with the
acknowledged ordered batch result. Events queued after the snapshot remain for the next batch. When
the queue is empty, it resolves to `{ results: [] }` without network I/O. A batch-level transport,
authentication, authorization, rate-limit, or outer-envelope failure rejects the promise through
the canonical fail-loud SDK error path; it never returns a false acceptance.

While the page is alive, normal retries reuse each event's generated ID. Page lifecycle flushing
uses authenticated `fetch()` and sets `keepalive: true` so the request may outlive the page. The SDK
does not use `navigator.sendBeacon()` because the ingest request requires the Client Key
`Authorization` header and strict request properties.

The queue is best-effort browser telemetry, not durable client storage. A crash, forced
termination, failed lifecycle flush, or keepalive limit may lose events that the Event Ingest Worker
has not accepted. The SDK never reports those events as accepted and does not restore them on the
next page load.

## Automatic instrumentation capture list

Automatic Web Analytics starts only through `sdk.web.instrument({ captures })`, which requires a
non-empty capture list. Each entry binds one explicitly selected browser instrumentation source to
one named App-level Event Definition in the `web` family. There is no wildcard, capture-all, or
automatically discovered instrumentation mode.

Each capture entry has exactly this strict shape:

```typescript
{
  source: "page_view" | "web_vital" | "browser_error";
  eventName: string;
}
```

The source selects one first-party Web Instrumentation Adapter and `eventName` selects the
destination Event Definition. Capture entries do not accept attribute maps, JSON paths, field
renames, transformation expressions, or caller-defined source names. An application that needs
custom shaping calls `sdk.web.track()` with a separately published Event Definition.

## Built-in Event Definition templates

`@splitch/contracts` exports one canonical Event Definition template for each built-in source. A
template contains the source key and exact `fields` and `dimensions` definitions required by that
adapter's current output contract. It does not choose an application-owned `eventName`, display
name, description, or `entityType`.

The browser SDK consumes the manifest in contract tests that prove each adapter output matches its
template. The control panel and CLI consume the same manifest to prefill the existing Event
Definition create and immutable Version publish requests. The user reviews and explicitly supplies
the Event Definition name, display metadata, and either anonymous-only or optional typed Entity
identity before publication.

Template use is an authoring convenience, not a data-plane mutation. It creates no new endpoint or
resource type. A Client Key cannot read, create, publish, or update Event Definitions, and
`web.instrument()` never repairs a missing or mismatched definition automatically.

`instrument()` returns an idempotent scoped cleanup function. Calling it:

- detaches that handle from each selected adapter and removes any browser listeners owned by the
  handle that support teardown;
- prevents that handle from producing new automatic Web Events;
- discards that handle's events that are still waiting in the in-memory queue;
- leaves manual `sdk.web.track()` events and other active instrumentation handles unchanged.

An adapter backed by a page-lifetime third-party collector may unsubscribe the handle while leaving
one inert shared collector installed until page termination. With no subscribers, that collector
does not create Web Events, access Web Session storage, queue data, or perform network I/O. This
exception is part of that adapter's documented contract and never permits duplicate collectors.

An event already included in an in-flight batch or accepted by ingest cannot be revoked by
`stop()`. Applications that want the handle's queued events delivered call `await sdk.web.flush()`
before stopping it.

Each browser instrumentation source may have at most one active owner per SDK client. A duplicate
source within one `captures` list or a source already owned by another active handle causes
`instrument()` to throw the canonical SDK validation error synchronously. This check occurs before
any adapter subscription or listener is registered, so a conflicting call has no partial side
effects. The event-name mapping does not make a duplicate source distinct.

Calling the owning handle's `stop()` releases its source ownership. A later `instrument()` call may
then register that source again.

Manual `sdk.web.track()` calls do not require a local capture-list entry. The explicit call is the
developer's local intent, and the Event Ingest Worker still requires the named, published `web`
Event Definition and validates its complete closed schema. Unknown or mismatched manual events fail
loud and write nothing.

The Client Key cannot read Event Definitions. Automatic capture configuration states developer
intent locally; the Event Ingest Worker remains authoritative for both manual and automatic events.
An unknown event name, unpublished definition, wrong-family definition, unknown field, or schema
mismatch fails loud and writes no Web Event.

## Browser instrumentation adapters

`page_view`, `web_vital`, and `browser_error` are the first supported browser instrumentation
sources. Each source is implemented behind one internal Web Instrumentation Adapter boundary. The
boundary has three real implementations from its first release and is tested by substituting a fake
adapter.

Each adapter publishes one fixed output contract as part of the versioned Splitch browser SDK
contract. It translates one explicitly selected browser signal into the configured Event Definition
name and that fixed set of `fields` and `dimensions`. It must discard all other source data before
the event enters the shared in-memory queue. It cannot add undeclared attributes, select an Event
Definition Version, bypass server validation, or use a different event envelope, route, retry
identity, or datasource.

An SDK patch or minor release may fix collection without changing an adapter's output shape. A
breaking adapter output change requires a new SDK major version and a newly published Event
Definition Version before those events can be accepted. Every accepted row already stamps both the
SDK version and the immutable Event Definition Version, so no separate caller-selected adapter
version exists.

The standard `web-vitals` version 6 package is a normal bundled dependency of the root
`@splitch/sdk` entry. Applications do not install a peer dependency, import a browser subpath, load a
CDN script, or await a dynamic adapter import. This keeps `sdk.web.instrument()` synchronous and
keeps one public client surface.

`@opentelemetry/api` is the only OpenTelemetry package bundled into the root SDK. Splitch does not
bundle or initialize an OpenTelemetry SDK, exporter, processor, context manager, propagator, or
instrumentation package. An application that already registered an OpenTelemetry provider uses the
same public global API; an application without one receives the API's no-op behavior and needs no
OpenTelemetry configuration.

Importing `@splitch/sdk` or creating a client must remain safe in neutral and server runtimes.
Bundled browser instrumentation performs no DOM, Performance Observer, storage, or listener work at
module evaluation or client construction. Those browser APIs are reached only after an explicit
`web.instrument()` call selects the relevant source. Package build and consumer-smoke tests must
prove Node import and ordinary Evaluation continue to work after bundling `web-vitals` and the
OpenTelemetry API.

Every queued Web Event is stamped with a stable `captureSource` and the Splitch `sdkVersion`.
Manual `sdk.web.track()` calls use `captureSource: "manual"`; application code cannot override it.
The first automatic adapters use `page_view`, `web_vital`, and `browser_error`. A later adapter
receives its own stable source key rather than reusing one of those values. The Event Ingest Worker
validates this bounded allowlist, but a direct Client Key HTTP caller can report any supported
source. Capture provenance is therefore advisory telemetry, not authenticated evidence.

Whenever the SDK creates a manual or automatic Web Event, it reads
`trace.getSpan(context.active())` through `@opentelemetry/api`. If the returned span has a valid span
context, the SDK stamps its `traceId` and `spanId`. With no active valid span, both fields remain
absent. Splitch never creates or ends a span as part of Web Event capture.

These nullable correlation fields are part of the Web Event envelope and physical datasource, not
Event Definition fields. Supplying only one, a zero identifier, or a value outside the lowercase
32-hex-character trace ID and 16-hex-character span ID shapes fails strict validation. The SDK does
not copy trace flags, trace state, span name, status, attributes, events, links, resources, or
instrumentation scope. Trace context never supplies Entity identity or Web Session identity.

OpenTelemetry browser instrumentation may implement an adapter behind this boundary. Splitch does
not register a catch-all OpenTelemetry bundle, expose a generic OpenTelemetry exporter, or accept
arbitrary OTLP spans as Web Events. Only configured signals mapped into the strict Splitch Web Event
contract may reach ingest. Adding a later first-party adapter requires a supported source, an
explicit capture mapping, and a published `web` Event Definition; it does not create another ingest
route or storage family.

Automatic instrumentation submits through the same internal path as `sdk.web.track()` rather than a
second event format or transport. The SDK retains internal handle ownership only to support scoped
cleanup; it is not a caller-supplied Web Event field and is not appended to `web_events`.
OpenTelemetry span duration, status, resource attributes, instrumentation scope, and signal-specific
attributes are not generic envelope fields. An adapter may map a needed value only into a field or
Dimension declared by the accepting immutable Event Definition Version.

### `page_view` adapter contract

The `page_view` adapter represents document lifecycle, not framework routing. While its handle is
active, it emits exactly one Web Event for the current document activation and one additional event
after each back-forward cache restoration. Registration before the initial `pageshow` waits for that
event; registration afterward emits the current activation immediately. These paths deduplicate so
one activation never emits twice.

The configured destination `eventName` is the semantic page identity. For example, an application
running instrumentation on its checkout document maps `page_view` to `checkout_page_view`. The
adapter emits this fixed payload:

```typescript
type PageViewAdapterPayload = {
  fields: Record<string, never>;
  dimensions: {
    navigationType:
      | "navigate"
      | "reload"
      | "back_forward"
      | "back_forward_cache"
      | "prerender"
      | "restore"
      | "unknown";
  };
};
```

The accepting Event Definition Version therefore declares no fields and one required string
Dimension named `navigationType`. Back-forward cache restoration emits `back_forward_cache`. An
unsupported or unavailable browser navigation type emits `unknown`; arbitrary source strings never
pass through. The adapter does not emit pathname, query, URL fragment, document title, referrer, DOM
content, or a framework route.

Single-page application route transitions are not document activations. Application code records
them explicitly through `sdk.web.track()` and a separately declared event contract. A later
framework-specific adapter may emit a declared route identifier without changing or broadening the
`page_view` contract.

### `web_vital` adapter contract

The `web_vital` adapter uses the standard `web-vitals` build and registers all five bounded metric
callbacks with `reportAllChanges: false`:

- Cumulative Layout Shift (`CLS`);
- First Contentful Paint (`FCP`);
- Interaction to Next Paint (`INP`);
- Largest Contentful Paint (`LCP`);
- Time to First Byte (`TTFB`).

Each callback queues one Web Event using the configured destination `eventName` and this fixed
payload:

```typescript
type WebVitalAdapterPayload = {
  fields: {
    value: number;
    delta: number;
  };
  dimensions: {
    metricName: "CLS" | "FCP" | "INP" | "LCP" | "TTFB";
    rating: "good" | "needs-improvement" | "poor";
    unit: "milliseconds" | "unitless";
    navigationType:
      | "navigate"
      | "reload"
      | "back_forward"
      | "back_forward_cache"
      | "prerender"
      | "restore"
      | "unknown";
  };
};
```

`CLS` uses `unitless`; the other four metrics use `milliseconds`. With
`reportAllChanges: false`, each callback contributes one logical report, so the adapter keeps only
the cumulative value and delta and drops the library's free-form metric ID. It normalizes the
library's bounded navigation type into the shared snake-case values above and emits `unknown` rather
than forwarding an unrecognized string.

The built-in `web_vital` Event Schema declares `value.numberKind = "measurement"` and
`delta.numberKind = "delta"`. Both numbers are finite and bounded from `-86_400_000` through
`86_400_000`; the adapter drops non-finite or out-of-contract values before queueing.

The adapter does not enable soft-navigation reporting. It drops raw `PerformanceEntry` objects,
attribution data, navigation URLs, DOM targets, and every undeclared library value before queueing.

The `web-vitals` registration functions do not expose unsubscribe handles. The adapter therefore
creates one lazy module-level collector per browser page and never registers the five callbacks more
than once, even when multiple SDK clients use it. Each active `web_vital` handle owns only a
subscription to that collector. `stop()` removes the subscription and its queued events; the
underlying observers remain until page termination and produce no Splitch storage or network
activity while there are no subscribers. A later `instrument()` call reuses the collector and
receives only future reports; it does not replay metrics produced while no subscriber existed.

### `browser_error` adapter contract

The `browser_error` adapter records bounded error counts without collecting error content. While its
handle is active, it listens for `window` `error` events whose payload is an `Error` and for
`unhandledrejection`. It ignores resource-load errors and never reads an element, request URL, or
response.

Each eligible signal queues one Web Event using the configured destination `eventName` and this
fixed payload:

```typescript
type BrowserErrorAdapterPayload = {
  fields: Record<string, never>;
  dimensions: {
    signal: "error" | "unhandled_rejection";
    exceptionType:
      | "Error"
      | "EvalError"
      | "RangeError"
      | "ReferenceError"
      | "SyntaxError"
      | "TypeError"
      | "URIError"
      | "AggregateError"
      | "DOMException"
      | "non_error"
      | "unknown";
  };
};
```

The adapter maps only known built-in error constructors into `exceptionType`. An unknown `Error`
subclass maps to `Error`, a non-Error rejection reason maps to `non_error`, and an inaccessible value
maps to `unknown`. It never reads or emits the error message, stack, filename, line or column,
rejection value, promise, source URL, breadcrumbs, DOM state, or arbitrary exception properties.
The listener is removed when its instrumentation handle stops.

## Automatic collection boundary

Automatic capture never reads or emits:

- form field values;
- DOM text or HTML;
- arbitrary element attributes;
- raw URLs or query strings;
- cookies or application storage;
- browser fingerprints;
- generic click, key, pointer, or interaction streams.

A later URL contract may allow declared, normalized, and redacted URL-derived fields. Until then,
automatic capture does not include them.

## Web Session activation

The SDK creates or reads the default tab-scoped Web Session only when the first manual or automatic
Web Event is produced. Calling `sdk.web.instrument()` may register selected instrumentation, but it
does not touch `sessionStorage` until an event is emitted. A normal SDK client therefore has no
browser analytics storage side effect. Supplying `web.sessionId` validates and retains only the
caller-provided UUID; it never reads or writes browser storage. Session generation and optional
application-supplied continuity are defined in
[web-event-identity.md](../pipeline/web-event-identity.md).

## Sources

- [web-event-identity.md](../pipeline/web-event-identity.md)
- [metric-event-contract.md](../pipeline/metric-event-contract.md)
- [privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [ADR-0042](../../adr/0042-event-ingest-is-strictly-defined-ahead-of-time.md)
- [GoogleChrome/web-vitals](https://github.com/GoogleChrome/web-vitals)
- [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/)
- [OpenTelemetry JavaScript tracing API](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/tracing.md)
- [Navigator.sendBeacon()](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)
- [Fetch Standard: keepalive requests](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)
