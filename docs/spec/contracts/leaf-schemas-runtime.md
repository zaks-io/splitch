# Leaf schemas: runtime events and identity/credential leaves

Canonical field lists for the runtime/identity glossary nouns: EvaluationContext, Exposure,
Event Definition, Metric Event, and the Organization/App/User/credential block. Every noun is ONE
Zod schema in `@splitch/contracts`; request, response, and storage shapes compose these leaves and
never redefine them.

Any field addition here propagates to every envelope automatically.

---

## EvaluationContext

Carried by every evaluate / test-evaluate request. `targetingKey` is first-class and separate from
attributes.

| Field          | Type                                                       | Required | Meaning                                                                                                                                |
| -------------- | ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `targetingKey` | `string`                                                   | yes      | The Entity identifier; the single stable identifier splitch buckets on                                                                 |
| `idType`       | `string`                                                   | yes      | Entity type label (e.g. `'user'`, `'workspace'`); included in the Assignment Store key and Exposure row to guard cross-type collisions |
| `attributes`   | `Record<string, boolean \| string \| number \| unknown[]>` | yes      | Arbitrary key-value bag for Condition matching; may be empty `{}`                                                                      |

---

## Exposure event

The only event on the Assignment/Exposure seam. Appended to Tinybird. Every field is required so
the wire `dedup_key` is always satisfiable.

| Field              | Type                         | Required | Meaning                                                                                                                                                                                 |
| ------------------ | ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dedupKey`         | `string` (sha256)            | yes      | Wire-level idempotency key; hashes `type`, identity fields, `sourceId`, and `eventId`; construction in [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md) |
| `eventId`          | `string`                     | yes      | Retry-stable physical raw-row id generated once before any retry                                                                                                                        |
| `appId`            | `string`                     | yes      | Isolation field; first in Tinybird sort key                                                                                                                                             |
| `environmentId`    | `string`                     | yes      | Co-scoped with `appId`; Exposures are per-Environment (ADR-0027)                                                                                                                        |
| `experimentId`     | `string`                     | yes      | —                                                                                                                                                                                       |
| `runId`            | `string`                     | yes      | Stamped at SDK fire-time from the live Run the SDK resolved; not ingest-time                                                                                                            |
| `idType`           | `string`                     | yes      | Entity type; part of Assignment Store key                                                                                                                                               |
| `targetingKeyHash` | `string`                     | yes      | HMAC-derived Entity identifier for storage; raw Targeting Key is never persisted                                                                                                        |
| `variantName`      | `string`                     | yes      | The Variant name served (string; Exposure logs name not id)                                                                                                                             |
| `type`             | `'exposure' \| 'activation'` | yes      | Discriminator; activations share this schema                                                                                                                                            |
| `sourceId`         | `string`                     | yes      | Edge POP identifier; component of `dedupKey`                                                                                                                                            |
| `counterfactual`   | `boolean`                    | yes      | `false` for real Exposures; reserved for future counterfactual triggering                                                                                                               |
| `clientTimestamp`  | `string` (ISO 8601)          | yes      | When the SDK fired the event (diagnostic only; subject to clock skew)                                                                                                                   |
| `serverReceivedAt` | `string` (ISO 8601)          | yes      | Server-received event timestamp; used for `MIN(ts)` first-touch ordering                                                                                                                |
| `ingestTs`         | `string` (ISO 8601)          | yes      | Raw-log append watermark; used by snapshot/tail only                                                                                                                                    |

First-touch identity: the tuple `(appId, environmentId, experimentId, runId, idType, targetingKeyHash)`
resolved by `MIN(serverReceivedAt)` — the earliest wins. Distinct from the wire `dedup_key` above.

---

## Event Definition

An Event Definition is App-level and shared by every Environment. `name` is the developer-facing
`eventName` used by `sdk.track(...)` and is unique within the App.

| Field                       | Type                | Required | Meaning                                                             |
| --------------------------- | ------------------- | -------- | ------------------------------------------------------------------- |
| `id`                        | `string`            | yes      | Stable ID (`evtdef_<ulid>`)                                         |
| `appId`                     | `string`            | yes      | Owning App                                                          |
| `name`                      | `string`            | yes      | Stable event name, unique within the App                            |
| `displayName`               | `string`            | yes      | Human-readable label                                                |
| `description`               | `string`            | no       | —                                                                   |
| `currentPublishedVersionId` | `string \| null`    | yes      | Version the Event Ingest Worker resolves; null before first publish |
| `createdAt`                 | `string` (ISO 8601) | yes      | —                                                                   |
| `updatedAt`                 | `string` (ISO 8601) | yes      | Metadata update timestamp                                           |

## Event Definition Version

Creating a version atomically publishes it and advances `currentPublishedVersionId`. A published
version is immutable and cannot be patched or deleted independently. A breaking contract change
creates a new version; accepted rows retain the exact version that validated them.

| Field               | Type                     | Required | Meaning                                                         |
| ------------------- | ------------------------ | -------- | --------------------------------------------------------------- |
| `id`                | `string`                 | yes      | Stable ID (`evtver_<ulid>`)                                     |
| `appId`             | `string`                 | yes      | Owning App; must match the Event Definition                     |
| `eventDefinitionId` | `string`                 | yes      | Parent Event Definition                                         |
| `version`           | positive integer         | yes      | Dense, server-assigned ordinal within the Event Definition      |
| `entityType`        | `string`                 | yes      | Required inbound `idType`; the Entity type this event describes |
| `fields`            | `EventFieldDefinition[]` | yes      | Named typed fact fields; names unique                           |
| `dimensions`        | `DimensionDefinition[]`  | yes      | Declared slice fields; names unique and disjoint from `fields`  |
| `schemaHash`        | `string` (sha256)        | yes      | Hash of the canonical fields/dimensions/entityType contract     |
| `publishedAt`       | `string` (ISO 8601)      | yes      | Server timestamp                                                |
| `publishedBy`       | `string`                 | yes      | WorkOS user ID or deleted-user tombstone                        |

`EventFieldDefinition`:

| Field        | Type                                          | Required | Meaning                                                            |
| ------------ | --------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `name`       | `string`                                      | yes      | Stable top-level name referenced by Metrics                        |
| `type`       | `'boolean' \| 'string' \| 'number' \| 'json'` | yes      | Accepted value family                                              |
| `required`   | `boolean`                                     | yes      | Whether every event must carry the field                           |
| `jsonSchema` | closed JSON Schema                            | cond.    | Required only when `type = 'json'`; root and nested objects closed |

`DimensionDefinition`:

| Field      | Type                                | Required | Meaning                                              |
| ---------- | ----------------------------------- | -------- | ---------------------------------------------------- |
| `name`     | `string`                            | yes      | Stable top-level Dimension name                      |
| `type`     | `'boolean' \| 'string' \| 'number'` | yes      | Scalar only; JSON Dimensions are not supported in V1 |
| `required` | `boolean`                           | yes      | Whether every event must carry the Dimension         |

JSON is accepted only for a field declared as `type = 'json'`. Its `jsonSchema` must set
`additionalProperties: false` for every object node, including nested objects. Schemaless JSON,
unknown field names, unknown Dimensions, unknown nested keys, and undeclared Entity Profile fields
fail before any write.

---

## Metric Event track request

The strict wire input for `POST /api/sdk/events`:

| Field          | Type                                                       | Required | Meaning                                                        |
| -------------- | ---------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| `eventName`    | `string`                                                   | yes      | App-level Event Definition name                                |
| `targetingKey` | `string`                                                   | yes      | Raw Entity identifier; used in memory and never stored         |
| `idType`       | `string`                                                   | yes      | Must equal the current Event Definition Version's `entityType` |
| `eventId`      | `string`                                                   | yes      | Caller-stable logical fact/retry identity                      |
| `fields`       | `Record<string, boolean \| string \| number \| JsonValue>` | yes      | Complete fact payload; validated against declared fields       |
| `dimensions`   | `Record<string, boolean \| string \| number>`              | yes      | Complete Dimension payload; validated against declarations     |

The object is strict. It has no App, Environment, hash, Entity Profile, Event Definition ID, or
version selector. `JsonValue` is accepted only after the named field's closed JSON Schema validates
the complete value.

## Accepted Metric Event row

The Event Ingest Worker constructs this shape only after the complete request validates:

| Field                      | Type                                          | Required | Meaning                                              |
| -------------------------- | --------------------------------------------- | -------- | ---------------------------------------------------- |
| `dedupKey`                 | `string` (sha256)                             | yes      | Idempotency key over App, Environment, and `eventId` |
| `eventId`                  | `string`                                      | yes      | Caller-stable logical fact ID                        |
| `appId`                    | `string`                                      | yes      | Injected from authenticated credential               |
| `environmentId`            | `string`                                      | yes      | Injected from authenticated credential               |
| `eventDefinitionId`        | `string`                                      | yes      | Resolved by `eventName` within the App               |
| `eventDefinitionVersionId` | `string`                                      | yes      | Current immutable version that accepted the row      |
| `eventName`                | `string`                                      | yes      | Denormalized stable definition name                  |
| `idType`                   | `string`                                      | yes      | Validated Entity type                                |
| `targetingKeyHash`         | `string`                                      | yes      | App-salt HMAC; raw Targeting Key is never persisted  |
| `fields`                   | `Record<string, JsonValue>`                   | yes      | Validated values serialized canonically              |
| `dimensions`               | `Record<string, boolean \| string \| number>` | yes      | Validated scalar Dimensions                          |
| `serverReceivedAt`         | `string` (ISO 8601)                           | yes      | Canonical Metric event time                          |
| `ingestTs`                 | `string` (ISO 8601)                           | yes      | Append watermark                                     |

The authoritative delivery, idempotency, validation, and response contract is
[metric-event-contract.md](../pipeline/metric-event-contract.md).

---

## ResolutionDetails (OpenFeature SDK return shape)

The shape every SDK accessor returns (`evaluate`, `evaluateDetails`, `peekVariant`, `verify`). For
`POST /api/sdk/verify` it is also the wire response because the endpoint is explicitly a
non-exposing setup-confirmation path. For exposing `evaluate`, the SDK may still synthesize
`ResolutionDetails` from the data-plane value plus the HTTP status. Either path gives the caller a
structured, fail-loud result (ADR-0036). It is the same OpenFeature `ResolutionDetails` shape the
verify and error contracts reference; defined here once.

| Field          | Type               | Required | Meaning                                                                                                       |
| -------------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| `value`        | `VariantValue`     | yes      | The resolved Variant value; the Default Variant value on a failure-fallback                                   |
| `variantName`  | `string \| null`   | yes      | The Variant name served; `null` when no Variant resolved (error / disabled with no Default)                   |
| `reason`       | `ResolutionReason` | yes      | Why this value was returned (enum below)                                                                      |
| `ruleId`       | `string`           | no       | Present iff `reason === 'TARGETING_MATCH'`; API-Key/control-plane only                                        |
| `errorCode`    | `ErrorCode`        | no       | Present iff `reason === 'ERROR'`; the canonical `ErrorCode` enum ([error-responses.md](./error-responses.md)) |
| `errorMessage` | `string`           | no       | Human-readable; present iff `reason === 'ERROR'`                                                              |

`ResolutionReason` enum:
`'SPLIT' | 'TARGETING_MATCH' | 'DEFAULT' | 'DISABLED' | 'CACHED' | 'STALE' | 'ERROR'`.
`VariantValue = boolean | string | number | JsonObject`.

A failure-fallback **always** carries `reason: 'ERROR'` + `errorCode`, never a silent default
(ADR-0036). Under a Client Key, `reason` is the non-revealing set and never names the matched rule
(ADR-0018); under an API Key, `verify` returns the full reason (ADR-0037). The HTTP-status →
`reason`/`errorCode` mapping the SDK applies is in
[../sdk/public-evaluate-endpoint.md](../sdk/public-evaluate-endpoint.md#http-status-to-resolutiondetails-mapping).

---

## Organization, App, Environment, User, SDK credentials

See [two-packages-topology.md](./two-packages-topology.md) for credential consumer policy.

### Organization

| Field       | Type                | Required | Meaning                |
| ----------- | ------------------- | -------- | ---------------------- |
| `id`        | `string`            | yes      | WorkOS Organization ID |
| `name`      | `string`            | yes      | —                      |
| `plan`      | `OrgPlan`           | yes      | Default `'free'`       |
| `createdAt` | `string` (ISO 8601) | yes      | —                      |
| `updatedAt` | `string` (ISO 8601) | yes      | —                      |

`OrgPlan` enum: `'free' | 'pro' | 'enterprise'`

### App

| Field            | Type                | Required | Meaning                 |
| ---------------- | ------------------- | -------- | ----------------------- |
| `id`             | `string`            | yes      | —                       |
| `organizationId` | `string`            | yes      | Owning Organization     |
| `name`           | `string`            | yes      | —                       |
| `key`            | `string`            | yes      | Unique per Organization |
| `description`    | `string`            | no       | —                       |
| `createdAt`      | `string` (ISO 8601) | yes      | —                       |
| `updatedAt`      | `string` (ISO 8601) | yes      | —                       |

### Environment

A first-class axis under App (ADR-0027). Experiments, Experiment Runs, Exposures, SDK credentials, and
Flag CONFIGURATION are scoped to one Environment.

| Field       | Type                | Required | Meaning                                           |
| ----------- | ------------------- | -------- | ------------------------------------------------- |
| `id`        | `string`            | yes      | Stable UUID                                       |
| `appId`     | `string`            | yes      | Owning App                                        |
| `key`       | `string`            | yes      | Unique per App (e.g. `'production'`, `'staging'`) |
| `name`      | `string`            | yes      | Display label                                     |
| `createdAt` | `string` (ISO 8601) | yes      | —                                                 |
| `updatedAt` | `string` (ISO 8601) | yes      | —                                                 |

### User

The User leaf is a wire response assembled from WorkOS profile data plus D1 membership rows. It is not
a D1 storage table.

| Field            | Type                | Required | Meaning                 |
| ---------------- | ------------------- | -------- | ----------------------- |
| `id`             | `string`            | yes      | WorkOS User ID          |
| `email`          | `string`            | yes      | —                       |
| `organizationId` | `string`            | yes      | Membership Organization |
| `role`           | `UserRole`          | yes      | —                       |
| `createdAt`      | `string` (ISO 8601) | yes      | —                       |

`UserRole` enum: `'owner' | 'admin' | 'member'`

### ClientKey

Client Keys are public publishable values. The control plane may retrieve and return
`keyMaterial` because it is safe to embed in client code. A Client Key can evaluate and can append
validated Metric Events through the write-only `track` route; it cannot read event or configuration
data.

| Field             | Type                        | Required | Meaning                                                                                                                                                                                          |
| ----------------- | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `keyId`           | `string`                    | yes      | Stable ID (`ck_<ulid>`)                                                                                                                                                                          |
| `appId`           | `string`                    | yes      | Scoped to one App                                                                                                                                                                                |
| `environmentId`   | `string`                    | yes      | Scoped to one Environment; co-scoped with `appId` (ADR-0027)                                                                                                                                     |
| `keyMaterial`     | `string`                    | yes      | Public value shipped to client code                                                                                                                                                              |
| `originAllowlist` | `string[] \| null`          | no       | `null` = open to all origins (auto-provision default, loudly flagged); `[]` = closed, serves nothing; non-empty = closed except listed origins. Lock down via `PATCH …/client-key` (ADR-0034 §1) |
| `rateLimitRps`    | `number \| null`            | no       | Per-key override                                                                                                                                                                                 |
| `revokedAt`       | `string \| null` (ISO 8601) | no       | —                                                                                                                                                                                                |
| `createdAt`       | `string` (ISO 8601)         | yes      | —                                                                                                                                                                                                |

### APIKey

API Keys are secret server-side credentials. The raw value is surfaced once at creation and
is never stored or returned later.

| Field           | Type                        | Required | Meaning                                                      |
| --------------- | --------------------------- | -------- | ------------------------------------------------------------ |
| `keyId`         | `string`                    | yes      | Stable ID (`ak_<ulid>`)                                      |
| `appId`         | `string`                    | yes      | Scoped to one App                                            |
| `environmentId` | `string`                    | yes      | Scoped to one Environment; co-scoped with `appId` (ADR-0027) |
| `scopes`        | `string[]`                  | yes      | Capability set                                               |
| `revokedAt`     | `string \| null` (ISO 8601) | no       | —                                                            |
| `createdAt`     | `string` (ISO 8601)         | yes      | —                                                            |

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
