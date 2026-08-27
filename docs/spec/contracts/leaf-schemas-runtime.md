# Leaf schemas: runtime events and identity/credential leaves

Canonical field lists for the runtime/identity glossary nouns: EvaluationContext, Exposure,
Event Definition, Metric Event, Web Event, and the Organization/App/User/credential block. Every
noun is ONE Zod schema in `@splitch/contracts`; request, response, and storage shapes compose these
leaves and never redefine them.

Any field addition here propagates to every envelope automatically.

---

## EvaluationContext

Carried by every evaluate / test-evaluate request. `targetingKey` is first-class and separate from
attributes.

| Field          | Type                                                       | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targetingKey` | `string`                                                   | yes      | The Entity identifier; the single stable identifier splitch buckets on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `idType`       | `string`                                                   | yes      | Entity type label (e.g. `'user'`, `'workspace'`); included in the Assignment Store key and Exposure row to guard cross-type collisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `attributes`   | `Record<string, boolean \| string \| number \| unknown[]>` | yes      | Arbitrary key-value bag for Condition matching; may be empty `{}`. `null` values are not valid on the wire — omit the key instead. Absent keys are a Condition non-match (see [evaluate-path-orchestration.md § Absent or null Condition attribute](../evaluation/evaluate-path-orchestration.md#absent-or-null-condition-attribute)). Array-valued attributes are compared element-wise by `eq` / `neq` / `in` / `not_in` (see [evaluate-path-orchestration.md § Array-valued Evaluation Context attributes](../evaluation/evaluate-path-orchestration.md#array-valued-evaluation-context-attributes)). |

---

## Exposure event

The only event on the Assignment/Exposure seam. Appended to Tinybird. Every field used by the wire
`dedup_key` is required; diagnostic client time is optional.

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
| `clientTimestamp`  | `string` (ISO 8601)          | no       | When the SDK fired the event (diagnostic only; subject to clock skew)                                                                                                                   |
| `exposureAt`       | `string` (ISO 8601)          | yes      | Canonical encounter time; remote receive time or verified trusted server commit                                                                                                         |
| `serverReceivedAt` | `string` (ISO 8601)          | yes      | When Splitch durably accepted the row; delivery diagnostics and retention                                                                                                               |

First-touch identity: the tuple `(appId, environmentId, experimentId, runId, idType, targetingKeyHash)`
resolved by `MIN(exposureAt)` — the earliest encounter wins. Distinct from the wire `dedup_key` above.
`ingestTs` is not a producer field. The Tinybird `raw_events` projection assigns physical
`ingest_ts` with `DEFAULT now64(3)` at insertion.

---

## Event Definition

An Event Definition is App-level and shared by every Environment. `name` is the developer-facing
event name and is unique within the App. `family` selects the Metric Event or Web Event contract and
cannot change after creation.

| Field                       | Type                | Required | Meaning                                                             |
| --------------------------- | ------------------- | -------- | ------------------------------------------------------------------- |
| `id`                        | `string`            | yes      | Stable ID (`evtdef_<ulid>`)                                         |
| `appId`                     | `string`            | yes      | Owning App                                                          |
| `name`                      | `string`            | yes      | Stable event name, unique within the App                            |
| `family`                    | `'metric' \| 'web'` | yes      | Immutable event family selected at creation                         |
| `displayName`               | `string`            | yes      | Human-readable label                                                |
| `description`               | `string`            | no       | —                                                                   |
| `currentPublishedVersionId` | `string \| null`    | yes      | Version the Event Ingest Worker resolves; null before first publish |
| `createdAt`                 | `string` (ISO 8601) | yes      | —                                                                   |
| `updatedAt`                 | `string` (ISO 8601) | yes      | Metadata update timestamp                                           |

## Event Definition Version

Creating a version atomically publishes it and advances `currentPublishedVersionId`. A published
version is immutable and cannot be patched or deleted independently. A breaking contract change
creates a new version; accepted rows retain the exact version that validated them.

The parent Event Definition supplies the family. A version request never carries `family`.
`entityType` is family-dependent; all other fields share one shape.

| Field               | Type                     | Required | Meaning                                                        |
| ------------------- | ------------------------ | -------- | -------------------------------------------------------------- |
| `id`                | `string`                 | yes      | Stable ID (`evtver_<ulid>`)                                    |
| `appId`             | `string`                 | yes      | Owning App; must match the Event Definition                    |
| `eventDefinitionId` | `string`                 | yes      | Parent Event Definition                                        |
| `version`           | positive integer         | yes      | Dense, server-assigned ordinal within the Event Definition     |
| `entityType`        | `string \| null`         | yes      | Family-specific Entity identity contract, defined below        |
| `fields`            | `EventFieldDefinition[]` | yes      | Named typed fact fields; names unique                          |
| `dimensions`        | `DimensionDefinition[]`  | yes      | Declared slice fields; names unique and disjoint from `fields` |
| `schemaHash`        | `string` (sha256)        | yes      | Hash of the canonical fields/dimensions/entityType contract    |
| `publishedAt`       | `string` (ISO 8601)      | yes      | Server timestamp                                               |
| `publishedBy`       | `string`                 | yes      | WorkOS user ID or deleted-user tombstone                       |

For a `metric` Event Definition, `entityType` must be a non-empty string and every inbound Metric
Event must carry a matching `idType`. For a `web` Event Definition:

- `entityType: null` makes the definition anonymous-only and rejects any supplied Entity identity;
- a non-empty `entityType` permits either an anonymous Web Event or a complete
  `targetingKey`/matching `idType` pair.

The request always includes `entityType`, including explicit `null`, so publication never infers the
privacy boundary from omitted input.

`EventFieldDefinition`:

| Field           | Type                                                                                  | Required | Meaning                                                                |
| --------------- | ------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `name`          | `string`                                                                              | yes      | Stable top-level name referenced by Metrics                            |
| `type`          | `'boolean' \| 'string' \| 'number' \| 'json'`                                         | yes      | Accepted value family                                                  |
| `required`      | `boolean`                                                                             | yes      | Whether every event must carry the field                               |
| `numberKind`    | `'measurement' \| 'count' \| 'amount' \| 'duration' \| 'ratio' \| 'score' \| 'delta'` | cond.    | Required only for number; declares a non-identifier measurement        |
| `allowedValues` | matching scalar array                                                                 | cond.    | Required for string; optional for boolean; one number-bounding option  |
| `minimum`       | finite `number`                                                                       | cond.    | Number lower bound; required with `maximum` when no numeric allowlist  |
| `maximum`       | finite `number`                                                                       | cond.    | Number upper bound; required with `minimum` when no numeric allowlist  |
| `jsonSchema`    | closed JSON Schema                                                                    | cond.    | Required only when `type = 'json'`; root and nested objects are closed |

`DimensionDefinition`:

| Field           | Type                                                                                  | Required | Meaning                                                         |
| --------------- | ------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| `name`          | `string`                                                                              | yes      | Stable top-level Dimension name                                 |
| `type`          | `'boolean' \| 'string' \| 'number'`                                                   | yes      | Scalar only; JSON Dimensions are not supported in V1            |
| `required`      | `boolean`                                                                             | yes      | Whether every event must carry the Dimension                    |
| `numberKind`    | `'measurement' \| 'count' \| 'amount' \| 'duration' \| 'ratio' \| 'score' \| 'delta'` | cond.    | Required only for number; declares a non-identifier measurement |
| `allowedValues` | matching scalar array                                                                 | cond.    | Required for string; optional for boolean; one numeric option   |
| `minimum`       | finite `number`                                                                       | cond.    | Number lower bound; required with `maximum` without allowlist   |
| `maximum`       | finite `number`                                                                       | cond.    | Number upper bound; required with `minimum` without allowlist   |

JSON is accepted only for a field declared as `type = 'json'`. Its `jsonSchema` must set
`additionalProperties: false` for every object node, including nested objects. Schemaless JSON,
unknown field names, unknown Dimensions, unknown nested keys, and undeclared Entity Profile fields
fail before any write.

Telemetry payloads never accept free-form strings or unbounded numbers. Every top-level string field
or Dimension requires a non-empty immutable `allowedValues` list, and every string node in a closed
JSON Schema requires a non-empty `enum`. An allowlist or string enum contains at most 256 values. Each
permitted string is a machine token of 1 to 64 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9_.:-]*`; whitespace, `@`, URL path/query delimiters, arbitrary text, and values
matching email, phone, IP address, URL, or UUID shapes are invalid.

Every number declares a `numberKind` and either a non-empty immutable `allowedValues`/`enum` of at
most 256 finite numbers or both finite `minimum` and `maximum` with `minimum <= maximum`. Runtime
values must be finite and satisfy that allowlist or inclusive range. A number cannot be published as
an identifier, opaque code, timestamp, phone number, postal code, or account number.

Before comparison, every definition and JSON property name is normalized by lowercasing and removing
ASCII `_`, `-`, `.`, and spaces. The normalized name is rejected when it equals a direct-identifier
name, including `email`, `emailaddress`, `name`, `fullname`, `firstname`, `lastname`, `phone`,
`phonenumber`, `address`, `streetaddress`, `ip`, `ipaddress`, `useragent`, `cookie`, `token`, `ssn`,
`socialsecuritynumber`, `taxid`, `passportnumber`, `driverslicensenumber`, `nationalid`,
`governmentid`, `userid`, `customerid`, `accountid`, `bankaccountnumber`, `creditcardnumber`,
`cardnumber`, `routingnumber`, `postalcode`, `zipcode`, `dateofbirth`, `birthdate`, `dob`,
`deviceid`, `sessionid`, or `targetingkey`. The same checks apply recursively to JSON property names.

These structural rules are the enforceable no-direct-PII publication boundary: they reject
identifier-shaped names, unconstrained strings, and undeclared or unbounded numeric semantics before
an Event Definition Version can publish. They cannot prove that a publisher has not deliberately
mislabelled personal data as an allowed machine token or bounded measurement; doing so is a contract
violation covered by definition review, audit, and privacy fixtures.

### Closed JSON Schema

`ClosedJsonSchema` is a recursive, strict project schema rather than an arbitrary JSON Schema
document. It supports exactly these node shapes:

```typescript
type NumberKind = "measurement" | "count" | "amount" | "duration" | "ratio" | "score" | "delta";

type ClosedJsonNumberSchema = {
  type: "number" | "integer";
  numberKind: NumberKind;
} & (
  | {
      enum: number[];
      minimum?: never;
      maximum?: never;
    }
  | {
      enum?: never;
      minimum: number;
      maximum: number;
    }
);

type ClosedJsonSchema =
  | {
      type: "object";
      properties: Record<string, ClosedJsonSchema>;
      required?: string[];
      additionalProperties: false;
    }
  | {
      type: "array";
      items: ClosedJsonSchema;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: "string";
      enum: string[];
    }
  | ClosedJsonNumberSchema
  | {
      type: "boolean";
      enum?: boolean[];
    }
  | {
      type: "null";
    };
```

Every node is strict and rejects unknown schema keywords. Object nodes must declare `properties`
and literal `additionalProperties: false`; `required`, when present, contains unique names that
exist in `properties`. Array nodes must declare one `items` schema. Item-count bounds are
non-negative finite integers. Numeric bounds are finite values and may be negative. Each minimum
must be less than or equal to its matching maximum. Every `enum` is non-empty, unique, and matches
the node's declared type. String enums and property names also pass the telemetry token and
direct-PII-name rules above.

V1 rejects `$ref`, `$defs`, remote references, recursive schemas, `patternProperties`,
`unevaluatedProperties`, schema-valued `additionalProperties`, unions, intersections, conditionals,
regular-expression patterns, formats, defaults, coercion, and unknown keywords. Nullability is
explicit through a `type: "null"` node; V1 does not accept a union with null. Changing any accepted
schema node changes `schemaHash` and requires a new immutable Event Definition Version.

Event Definition publication validates the schema itself. Event ingest validates the complete JSON
value recursively against the stamped schema without coercion. A schema-definition failure returns
`VALIDATION_ERROR`; an event-value failure returns `EVENT_SCHEMA_MISMATCH`. Neither failure writes
an Event Definition Version, event claim, outbox payload, queue message, or Tinybird row.

`allowedValues` contains unique JSON scalar values that exactly match the declared scalar type. It is
required for a string declaration, optional for boolean, one of the two required numeric-domain
branches for number, and invalid on a `json` field, whose JSON Schema uses `enum` instead. A number
without `numberKind` or with neither a numeric allowlist nor both bounds fails publication. Ingest
rejects a value outside the published allowlist with `EVENT_SCHEMA_MISMATCH`. Allowlists participate
in `schemaHash`; changing one requires a new immutable Event Definition Version.

`minimum` and `maximum` are valid only for a number declaration and are inclusive. Both values must
be finite, cannot be combined with a numeric allowlist, and publication rejects
`minimum > maximum`. Ingest rejects out-of-range values with `EVENT_SCHEMA_MISMATCH`. Bounds
participate in `schemaHash`; changing either requires a new immutable Event Definition Version.

## Built-in Web Instrumentation Adapter templates

`@splitch/contracts` exports a canonical immutable manifest used by the SDK, control panel, and CLI.
Each template contains only:

| Field        | Type                                            | Required | Meaning                                  |
| ------------ | ----------------------------------------------- | -------- | ---------------------------------------- |
| `source`     | `'page_view' \| 'web_vital' \| 'browser_error'` | yes      | Built-in adapter key                     |
| `fields`     | `EventFieldDefinition[]`                        | yes      | Exact source-owned field definitions     |
| `dimensions` | `DimensionDefinition[]`                         | yes      | Exact source-owned Dimension definitions |

The templates are:

| Source          | Fields                                                                                   | Dimensions                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `page_view`     | none                                                                                     | required string `navigationType`                                                                                 |
| `web_vital`     | required measurement `value` and delta `delta`, each bounded `[-86_400_000, 86_400_000]` | required string `metricName`; required string `rating`; required string `unit`; required string `navigationType` |
| `browser_error` | none                                                                                     | required string `signal`; required string `exceptionType`                                                        |

The templates apply these closed scalar allowlists:

- `navigationType`: `navigate`, `reload`, `back_forward`, `back_forward_cache`, `prerender`,
  `restore`, `unknown`;
- `metricName`: `CLS`, `FCP`, `INP`, `LCP`, `TTFB`;
- `rating`: `good`, `needs-improvement`, `poor`;
- `unit`: `milliseconds`, `unitless`;
- `signal`: `error`, `unhandled_rejection`;
- `exceptionType`: `Error`, `EvalError`, `RangeError`, `ReferenceError`, `SyntaxError`, `TypeError`,
  `URIError`, `AggregateError`, `DOMException`, `non_error`, `unknown`.

The manifest does not contain `eventName`, display metadata, description, or `entityType`; those are
application-owned publication choices. Authoring tools expand a template into the ordinary strict
Event Definition Version request. The API never accepts a template selector.

---

## Metric Event track request

The strict wire input for `POST /api/sdk/events`:

| Field          | Type                                                       | Required | Meaning                                                        |
| -------------- | ---------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| `eventName`    | `string`                                                   | yes      | App-level Event Definition name                                |
| `targetingKey` | `string`                                                   | yes      | Raw Entity identifier; used in memory and never stored         |
| `idType`       | `string`                                                   | yes      | Must equal the current Event Definition Version's `entityType` |
| `eventId`      | `string` (UUID)                                            | yes      | Caller-stable logical fact/retry identity                      |
| `fields`       | `Record<string, boolean \| string \| number \| JsonValue>` | yes      | Complete fact payload; validated against declared fields       |
| `dimensions`   | `Record<string, boolean \| string \| number>`              | yes      | Complete Dimension payload; validated against declarations     |

The object is strict. It has no App, Environment, hash, Entity Profile, Event Definition ID, or
version selector. `eventId` must use the canonical lowercase UUID shape. `JsonValue` is accepted
only after the named field's closed JSON Schema validates the complete value.

The complete UTF-8 encoded Metric Event request body may not exceed 32 KiB (32,768 bytes). The
Worker enforces the byte limit before Event Definition resolution, admission, a claim, or an outbox
write.

## Accepted Metric Event row

The Event Ingest Worker constructs this shape only after the complete request validates:

| Field                      | Type                                          | Required | Meaning                                              |
| -------------------------- | --------------------------------------------- | -------- | ---------------------------------------------------- |
| `dedupKey`                 | `string` (sha256)                             | yes      | Idempotency key over App, Environment, and `eventId` |
| `eventId`                  | `string` (UUID)                               | yes      | Caller-stable logical fact ID                        |
| `appId`                    | `string`                                      | yes      | Injected from authenticated credential               |
| `environmentId`            | `string`                                      | yes      | Injected from authenticated credential               |
| `eventDefinitionId`        | `string`                                      | yes      | Resolved by `eventName` within the App               |
| `eventDefinitionVersionId` | `string`                                      | yes      | Current immutable version that accepted the row      |
| `eventName`                | `string`                                      | yes      | Denormalized stable definition name                  |
| `idType`                   | `string`                                      | yes      | Validated Entity type                                |
| `targetingKeyHash`         | `string`                                      | yes      | Stable App Entity HMAC; raw Targeting Key is absent  |
| `fields`                   | `Record<string, JsonValue>`                   | yes      | Validated values serialized canonically              |
| `dimensions`               | `Record<string, boolean \| string \| number>` | yes      | Validated scalar Dimensions                          |
| `serverReceivedAt`         | `string` (ISO 8601)                           | yes      | Canonical Metric event time                          |

The authoritative delivery, idempotency, validation, and response contract is
[metric-event-contract.md](../pipeline/metric-event-contract.md).
The physical Tinybird projection adds server-assigned insertion timestamp `ingest_ts` with datasource
`DEFAULT now64(6)`; the sealed canonical payload and queue message omit it.

---

## Web Event batch request

`POST /api/sdk/web-events` accepts only this strict outer envelope:

| Field    | Type                     | Required | Meaning                                      |
| -------- | ------------------------ | -------- | -------------------------------------------- |
| `events` | `WebEventTrackRequest[]` | yes      | 1 to 25 items; one-item batches are accepted |

A bare `WebEventTrackRequest` is invalid. The SDK always sends the batch envelope, including when a
flush contains one Web Event. Each item has an independent retry identity and this strict shape:

| Field           | Type                                                       | Required | Meaning                                                                         |
| --------------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `eventName`     | `string`                                                   | yes      | App-level `web` Event Definition name                                           |
| `eventId`       | `string` (UUID)                                            | yes      | Logical retry identity generated by the browser SDK                             |
| `sessionId`     | `string` (UUID)                                            | yes      | Opaque Web Session identifier; SDK-generated by default                         |
| `captureSource` | `string`                                                   | yes      | Supported source key; `manual`, `page_view`, `web_vital`, or `browser_error` V1 |
| `sdkVersion`    | `string` (bounded SemVer)                                  | yes      | Splitch browser SDK version                                                     |
| `traceId`       | `string` (32 lowercase hex)                                | cond.    | Optional W3C trace ID; present exactly when `spanId` is                         |
| `spanId`        | `string` (16 lowercase hex)                                | cond.    | Optional W3C span ID; present exactly when `traceId` is                         |
| `targetingKey`  | `string`                                                   | cond.    | Explicit Entity identifier; present exactly when `idType` is                    |
| `idType`        | `string`                                                   | cond.    | Explicit Entity type; present exactly when `targetingKey` is                    |
| `fields`        | `Record<string, boolean \| string \| number \| JsonValue>` | yes      | Complete fact payload; validated against declared fields                        |
| `dimensions`    | `Record<string, boolean \| string \| number>`              | yes      | Complete Dimension payload; validated against declarations                      |

`targetingKey` and `idType` are optional as a pair. Supplying only one fails strict validation.
`sessionId` must use the canonical lowercase UUID shape. `sdkVersion` must be at most 32 characters
and match `MAJOR.MINOR.PATCH` or the bounded prerelease forms `-alpha.N`, `-beta.N`, or `-rc.N`.
`traceId` and `spanId` are optional as a pair and must both be non-zero when present. The source key
must be supported by the deployed SDK contract; there is no caller-defined source namespace. App
and Environment come from the authenticated SDK credential. The fragment has no Entity Profile,
Experiment, Run, Variant, Exposure, Metric Event, Event Definition ID, or version selector.
Application code does not supply `eventId` to `sdk.web.track()`; the SDK adds it to the wire request
and retains it across retries. It also stamps `captureSource` and `sdkVersion`; the public manual
event input cannot override them. Direct HTTP callers can report any supported capture source and
bounded SDK version, so those values are advisory rather than authenticated provenance.

After resolving the current `web` Event Definition Version, the Worker rejects identity when
`entityType` is null. When it is non-null, the identity pair remains optional, but a supplied
`idType` must match.

The complete UTF-8 encoded JSON request body may not exceed 32 KiB (32,768 bytes). The Worker
measures bytes, not JavaScript string length. The outer envelope validates the byte limit,
authentication, the per-credential rate limit, strict top-level fields, the 1-to-25 item count, and a
valid UUID `eventId` on every item before processing any item. Once those gates pass, item schema
validation and existing-claim lookup are independent. The aggregate Ingest Admission Gate then
charges all remaining new canonical items as one batch; failure rejects the complete request before
new claims or outbox writes. After admission passes, new item claims and canonical payloads are
sealed independently.

## Accepted Web Event row

The Event Ingest Worker constructs this shape only after the complete request validates:

| Field                      | Type                                          | Required | Meaning                                                  |
| -------------------------- | --------------------------------------------- | -------- | -------------------------------------------------------- |
| `dedupKey`                 | `string` (sha256)                             | yes      | Family-scoped idempotency key                            |
| `eventId`                  | `string`                                      | yes      | SDK-generated logical fact ID                            |
| `appId`                    | `string`                                      | yes      | Injected from authenticated credential                   |
| `environmentId`            | `string`                                      | yes      | Injected from authenticated credential                   |
| `eventDefinitionId`        | `string`                                      | yes      | Resolved by `eventName` within the App                   |
| `eventDefinitionVersionId` | `string`                                      | yes      | Current immutable version that accepted the row          |
| `eventName`                | `string`                                      | yes      | Denormalized stable definition name                      |
| `sessionIdHash`            | `string`                                      | yes      | App/Environment-scoped HMAC of the wire Web Session ID   |
| `captureSource`            | `string`                                      | yes      | Validated advisory capture source                        |
| `sdkVersion`               | `string`                                      | yes      | Splitch browser SDK version                              |
| `traceId`                  | `string`                                      | no       | Validated W3C trace ID                                   |
| `spanId`                   | `string`                                      | no       | Validated W3C span ID                                    |
| `idType`                   | `string`                                      | no       | Explicit Entity type                                     |
| `targetingKeyHash`         | `string`                                      | no       | Stable App Entity HMAC; absent for anonymous events      |
| `fields`                   | `Record<string, JsonValue>`                   | yes      | Values validated against the accepting immutable version |
| `dimensions`               | `Record<string, boolean \| string \| number>` | yes      | Validated scalar Dimensions                              |
| `serverReceivedAt`         | `string` (ISO 8601)                           | yes      | Canonical Web Event time                                 |

`WebEventBatchResult` is the route response and the return type of `sdk.web.flush()`. The route
returns it with `202`; an empty SDK queue returns the same shape locally without network I/O:

| Field                                | Type                                      | Required | Meaning                                  |
| ------------------------------------ | ----------------------------------------- | -------- | ---------------------------------------- |
| `results[].eventId`                  | `string` (UUID)                           | yes      | Matches one input item                   |
| `results[].status`                   | `'accepted' \| 'duplicate' \| 'rejected'` | yes      | Independent logical result               |
| `results[].eventDefinitionId`        | `string`                                  | cond.    | Present for accepted and duplicate items |
| `results[].eventDefinitionVersionId` | `string`                                  | cond.    | Originally accepting immutable version   |
| `results[].error`                    | `ErrorResponse`                           | cond.    | Present only for a rejected item         |

Results preserve input order. A rejected item creates no idempotency claim and no `web_events` row;
valid sibling items remain independently accepted.

The physical Tinybird projection adds server-assigned insertion timestamp `ingest_ts` with datasource
`DEFAULT now64(6)`; the sealed canonical payload and queue message omit it.

A Web Session may correlate events before and after explicit Entity identity appears. Earlier rows
remain anonymous facts and are not rewritten, promoted into Entity facts, or admitted to Experiment
measurement. Exploratory queries derive one session association from distinct non-null `(idType,
targetingKeyHash)` pairs across retained rows. Zero pairs remains anonymous, one pair associates the
journey with that Entity, and more than one pair produces an Ambiguous Web Session attributed to no
Entity. This projection never mutates accepted rows. The authoritative boundary is
[web-event-identity.md](../pipeline/web-event-identity.md). The route and capture boundary are
defined in [web-analytics-capture.md](../sdk/web-analytics-capture.md).

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

| Field             | Type                                              | Required | Meaning                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keyId`           | `string`                                          | yes      | Stable ID (`ck_<ulid>`)                                                                                                                                                                                   |
| `appId`           | `string`                                          | yes      | Scoped to one App                                                                                                                                                                                         |
| `environmentId`   | `string`                                          | yes      | Scoped to one Environment; co-scoped with `appId` (ADR-0027)                                                                                                                                              |
| `keyMaterial`     | `string`                                          | yes      | Public value shipped to client code                                                                                                                                                                       |
| `originAllowlist` | `string[] \| null`                                | no       | `null` = open to all origins (auto-provision default, loudly flagged); `[]` = closed, serves nothing; non-empty = closed except listed origins. Lock down via `PATCH …/client-key` (ADR-0034 §1)          |
| `rateLimitRps`    | exact integer `1–100` that divides 300, or `null` | no       | PATCH/write set: `1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 25, 30, 50, 60, 75, 100`. `null` = ADR 100 rps default. Read-side KV may still carry a legacy number; Evaluation fail-closes those as `RATE_LIMITED`. |
| `revokedAt`       | `string \| null` (ISO 8601)                       | no       | —                                                                                                                                                                                                         |
| `createdAt`       | `string` (ISO 8601)                               | yes      | —                                                                                                                                                                                                         |

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
