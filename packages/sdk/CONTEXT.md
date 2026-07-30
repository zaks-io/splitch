# Public SDK context

Read this when touching `packages/sdk`, public runtime docs, evaluation accessors, or client key
handling.

## Owns

- Public data-plane SDK language.
- Client Key and API Key distinction from the runtime user's point of view.
- Evaluation accessor behavior, including Exposure firing and peek.
- Runtime-safe wording for browser, mobile, server, and edge SDKs.

## Credential terms

**Client Key**:
The public, non-secret identifier a client-side SDK presents. It is safe to embed in shipped client
code. It evaluates Flags and submits Metric Events and schema-defined Web Events for exactly
one App in exactly one Environment. Its only write capabilities are the strictly validated,
write-only `track()` and `web.track()` accessors, which reveal no Event Definition or configuration.
It cannot read full flag config, Targeting Rules, salts, Metric Events, Web Events, mint keys, or
reach another App.

Abuse is bounded at the edge by controls such as origin/referrer allow-listing and rate limiting, not
by hiding the value.

Avoid: treating it as secret; calling it an API Key; using it for server-side full access.

**API Key**:
The secret credential a server-side SDK presents for full data-plane access. It is scoped to exactly
one Environment. Never ship it to a browser or mobile client.

Avoid: using it client-side; reading back an existing API Key value after creation.

## Evaluation terms

**Targeting Key**:
The stable identifier the SDK passes for evaluation. It is configurable by use case and may represent
a user, session, workspace, service, or other Entity.

**Evaluation Context**:
The object carrying the Targeting Key and attributes used for Targeting.

**Evaluation vs Resolution**:
Evaluation is the SDK-facing flag value retrieval, including hooks and fallback. Resolution is the
Provider retrieving a value from its source of truth.

**Resolution Details**:
The OpenFeature result shape every accessor speaks: `value`, `variantName`, `reason`,
`errorCode?`, `errorMessage?`. `evaluate` returns the value; `evaluateDetails` returns the full
shape. `reason` and `errorCode` use the OpenFeature standard enums. See ADR-0036.

**Reason**:
Why an evaluation produced its value (`SPLIT`, `TARGETING_MATCH`, `DEFAULT`, `DISABLED`,
`CACHED`, `STALE`, `ERROR`). Under a Client Key it is the non-revealing subset and never names
the matched rule (ADR-0018). `TARGETING_MATCH` + rule identity are API-Key / control-plane only.

**idType**:
The Entity type label (`'user'`, `'workspace'`, ...). Required on the wire; the SDK defaults it
to `'user'` and lets the caller override it. See ADR-0036.

**Verify**:
The non-exposing "is my setup correct" accessor. Available on every credential tier; what it
reveals scales with credential trust (ADR-0037). Distinct from peek (API-Key-only).

**Assignment**:
The pure deterministic selection of a Variant for an Entity in an Experiment Run. Assignment is not an
event.

**Exposure**:
The event fired when the Entity actually encounters the assigned Variant. The normal SDK accessor
fires Exposure. A separate peek accessor resolves without exposing.

**Test evaluation / dry-run**:
A non-exposing evaluation path used for debugging and verification. It records no Exposure.

**Track**:
The top-level stateless Metric Event accessor:
`track(eventName, { targetingKey, idType, eventId, fields, dimensions })`. Every call carries
explicit Entity identity and a caller-stable UUID retry ID. There is no `identify()` state and
callers cannot select an Event Definition Version. It never accepts or infers Web Events.

**Web Track**:
The Web Event accessor under `web.track(eventName, event)`. Calling it activates manual Web Event
delivery without a separate enable or local capture-list entry. It never accepts or infers Metric
Events. The SDK generates one stable Web Event ID per logical call and reuses it for retries;
application code does not manage that ID.

**Web Instrument**:
The automatic browser instrumentation accessor under `web.instrument({ captures })`. It requires a
non-empty explicit capture list and has no wildcard or discovered-source mode. It returns an
idempotent scoped cleanup function that detaches its adapter subscriptions, removes listeners that
support teardown, and discards only its queued automatic events. Each strict capture entry contains
only a supported `source` and destination `eventName`. One browser source may have only one active
owner per SDK client.

**Web Instrumentation Adapter**:
An internal browser SDK adapter that translates one supported browser instrumentation source into
one configured, schema-governed Web Event. The first supported sources are `page_view` and
`web_vital`. Each adapter has a fixed output contract versioned with the SDK; later adapters may use
OpenTelemetry instrumentation without exposing raw OTLP or a second ingest path.

**Web Flush**:
The acknowledged `web.flush()` accessor. It sends the current in-memory Web Event queue and resolves
with ordered per-item results; an empty queue resolves without network I/O.

**Web Session**:
The bounded browser activity scope carried by every Web Event; it may accompany optional explicit
Entity identity but never replaces the Targeting Key for experiment measurement.

**Web Analytics**:
Opt-in browser instrumentation that emits only explicitly configured Web Events.

## SDK behavior rules

- Public clients do remote Evaluation. They do not receive Targeting Rules or local rule-evaluation
  snapshots.
- Exposure-bearing `evaluate` and `evaluateDetails` require a caller-owned `idempotencyKey`, reused
  for retries of the same logical Evaluation. The server cannot infer retries automatically; a new
  key is a new billable Evaluation. `peek` and `verify` are non-billing and do not require one.
- SDK caches may cache evaluated results. They must not cache or expose rule logic.
- The SDK seen-set is a hot-path optimization only. Pipeline dedup is authoritative.
- Reading through the exposing accessor fires Exposure.
- Peeking must be explicit and loudly named.
- Tracking is write-only, strict, and fail-loud. Unknown fields, Dimensions, nested JSON keys, or
  Entity profile properties return the canonical validation error and perform no append, so rejected
  Metric Events are distinguishable from successful ingestion.
- The browser SDK creates a cryptographically random Web Session in `sessionStorage` by default, so
  it survives same-tab navigation but not tab close.
- The SDK never creates Web Sessions with cookies, `localStorage`, browser fingerprinting, or
  cross-site identity. Applications may explicitly supply an opaque, consent-aware Web Session
  identifier for broader continuity.
- Creating a normal client does not touch the DOM, browser performance APIs, or `sessionStorage`.
  Manual collection starts with the first `web.track()` call; automatic collection starts only
  through `web.instrument({ captures })`. There is no generic `web.enable()`.
- Automatic Web Analytics has no wildcard or capture-all mode. Each configured capture binds one
  selected instrumentation source to one named `web` Event Definition.
- V1 Web Analytics does not sample. Every eligible event from an explicitly selected automatic
  source and every explicit `web.track()` call enters the normal queue. Rate limits reject a
  complete batch loudly with `RATE_LIMITED`; neither the SDK nor ingest silently thins or accepts
  it.
- A capture entry contains only `source` and `eventName`. It has no attribute map, JSON path, field
  rename, transformation expression, or caller-defined source. Custom shaping uses explicit
  `web.track()`.
- `@splitch/contracts` owns canonical Event Definition templates for built-in adapters. SDK contract
  tests prove adapter output matches them; the control panel and CLI use the same templates to
  prefill existing authenticated authoring requests. Client Keys never auto-create definitions.
- `page_view`, `web_vital`, and privacy-safe `browser_error` are the first supported Web
  Instrumentation Adapters. Every adapter drops unmapped source data before queueing and submits
  through the same strict Web Event path. OpenTelemetry may implement an adapter, but raw OTLP,
  generic exporters, and undeclared OpenTelemetry attributes are outside the SDK contract.
- Adapter output contracts are versioned with the browser SDK. Patch and minor releases preserve
  their shapes; a breaking shape change requires a new SDK major and Event Definition Version.
- The browser SDK contract bundles `web-vitals` version 6 into the root `@splitch/sdk` package. It
  requires no peer, subpath, CDN, or asynchronous loader. Import and client construction remain
  browser-side-effect free and safe in neutral runtimes; browser APIs are touched only by explicit
  instrumentation.
- The browser SDK contract bundles only `@opentelemetry/api` from OpenTelemetry. At Web Event
  creation the SDK copies a valid active span's trace and span IDs, or leaves both absent. It
  creates no span and copies no trace flags, trace state, attributes, resources, events, links, or
  scope.
- `page_view` emits once for the current document activation and after each back-forward cache
  restoration. Its destination `eventName` is the semantic page identity, and its only payload value
  is the required `navigationType` Dimension. It never derives a page name from a URL, title, DOM, or
  framework route; SPA transitions use explicit `web.track()`.
- `web_vital` registers the standard `CLS`, `FCP`, `INP`, `LCP`, and `TTFB` callbacks without
  all-change or soft-navigation reporting. It emits only metric ID, value, delta, rating, unit,
  metric name, and normalized navigation type. Raw entries, attribution, URLs, and DOM targets are
  dropped.
- `web_vital` uses one lazy module-level collector per page because the library does not expose
  teardown. Handles subscribe and unsubscribe without duplicate collector registration. With no
  subscribers, it creates no Web Events, storage access, queued data, or network I/O.
- `browser_error` emits only a bounded signal kind and normalized built-in exception type. It never
  reads or emits messages, stacks, filenames, source URLs, rejection values, breadcrumbs, or DOM
  state.
- Every queued Web Event carries a validated `captureSource` and `sdkVersion`. Manual events use
  `manual`; automatic events use their adapter's stable source key. Public SDK methods do not expose
  overrides, but a direct Client Key HTTP caller can report any supported source, so provenance is
  advisory. An adapter may add paired W3C `traceId` and `spanId` correlation from the active
  OpenTelemetry context, but these values never create Entity or Web Session identity.
- Each `web.instrument()` call owns its adapter subscriptions, removable listeners, and queued
  automatic events. Its cleanup leaves manual events and other instrumentation handles unchanged;
  in-flight or accepted events cannot be revoked.
- Duplicate browser sources within one capture list or across active instrumentation handles fail
  synchronously before any adapter subscription or handle-owned listener is registered. Stopping the
  owner releases the source for later registration.
- Top-level `track()` submits only Metric Events. `web.track()` submits only Web Events. Neither
  accessor infers an Event family from the payload or a server lookup.
- Manual `web.track()` calls and automatic browser instrumentation use the same strict Web Event
  submission path. Manual calls need no local capture-list entry; the Event Ingest Worker remains
  authoritative for the named published `web` Event Definition and closed schema.
- The Web Event route accepts only a non-empty `{ events: [...] }` batch envelope, including for a
  one-event flush. A batch holds at most 25 events and a 32 KiB UTF-8 JSON body. Retry identity
  remains per Web Event item.
- Batch-level auth or structural failures reject the whole request. After those gates pass, each Web
  Event is accepted, deduplicated, or rejected independently by `eventId`; an invalid item does not
  block valid siblings.
- Web Event delivery uses the existing injectable logger, not a second hook system. Permanent item
  rejections and failed background batches log once per attempt with identifiers, codes, issue
  paths, status, and count only. Event values, session or Entity identity, hashes, and trace context
  are never logged.
- Pending Web Events, event IDs, and retry state are memory-only. The SDK never persists them to
  IndexedDB, `localStorage`, `sessionStorage`, cookies, or another browser store. Page lifecycle
  delivery uses authenticated `fetch` with `keepalive`.
- The Web Event queue flushes after five seconds from its first event, at either batch limit, or when
  the page becomes hidden, with `pagehide` as fallback. No timer or lifecycle listener exists while
  the queue is empty.
- `web.flush()` awaits an acknowledged batch result and fails loud on batch-level failure. Events
  queued after its snapshot belong to the next batch.
- Automatic capture never reads form values, DOM text, or raw URLs and never registers generic
  click or interaction listeners.
- Evaluation is **fail-loud**: a failure-fallback to the Default Variant always carries
  `reason: ERROR` + `errorCode` and a loud log/hook, never a silent default (ADR-0036). A
  disabled / no-config / no-match flag is a normal `DEFAULT`/`DISABLED`, not an error.

## Example dialogue

> Dev: "We're running an Experiment on `new-checkout`. Is the Targeting Key the user or the
> workspace?"
>
> Domain expert: "Workspace. The Entity is the account, so everyone in a workspace gets the same
> Variant. Set the Targeting Key to `workspaceId`."
>
> Dev: "And we count an Exposure when the flag is evaluated?"
>
> Domain expert: "No. Assignment happens at evaluation, but Exposure only counts when they actually
> hit the checkout page. The significance math runs over Exposures, not Assignments."

## Related context

- Evaluation domain: [`../../apps/evaluation-api/CONTEXT.md`](../../apps/evaluation-api/CONTEXT.md)
- Event ingest: [`../../apps/event-ingest-api/CONTEXT.md`](../../apps/event-ingest-api/CONTEXT.md)
- Credential provisioning: [`../../apps/control-plane-api/CONTEXT.md`](../../apps/control-plane-api/CONTEXT.md)
