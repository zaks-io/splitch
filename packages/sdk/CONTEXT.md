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
code. It evaluates Flags and submits Metric Events for exactly one App in exactly one Environment.
Its only write capability is `track()`: a strictly validated, write-only append that reveals no
Event Definition or configuration. It cannot read full flag config, Targeting Rules, salts, Metric
Events, mint keys, or reach another App.

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
The stateless Metric Event accessor:
`track(eventName, { targetingKey, idType, eventId, fields, dimensions })`. Every call carries
explicit Entity identity and a caller-stable retry ID. There is no `identify()` state and callers
cannot select an Event Definition Version.

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
