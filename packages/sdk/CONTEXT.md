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
code. It evaluates Flags for exactly one App in exactly one Environment. It cannot read full flag
config, Targeting Rules, salts, write data, mint keys, or reach another App.

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

**Assignment**:
The pure deterministic selection of a Variant for an Entity in an Experiment Run. Assignment is not an
event.

**Exposure**:
The event fired when the Entity actually encounters the assigned Variant. The normal SDK accessor
fires Exposure. A separate peek accessor resolves without exposing.

**Test evaluation / dry-run**:
A non-exposing evaluation path used for debugging and verification. It records no Exposure.

## SDK behavior rules

- Public clients do remote Evaluation. They do not receive Targeting Rules or local rule-evaluation
  snapshots.
- SDK caches may cache evaluated results. They must not cache or expose rule logic.
- The SDK seen-set is a hot-path optimization only. Pipeline dedup is authoritative.
- Reading through the exposing accessor fires Exposure.
- Peeking must be explicit and loudly named.

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
