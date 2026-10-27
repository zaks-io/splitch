# Control-plane endpoints: Event Definition and Metric

Request/response shapes for the shared App-level Event Definition catalog, immutable published
versions, and Metrics. An Event Definition has one immutable `metric` or `web` family. All endpoints
live on the Control Plane API Worker and require a control-plane bearer token. Requests/responses
are `Content-Type: application/json`. Shared errors and pagination are defined in
[control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

Event Definitions and Metrics are App-level. Metric Events are per-Environment data-plane facts and
execute on the Event Ingest Worker through the Evaluation public address described in
[metric-event-contract.md](../pipeline/metric-event-contract.md).

Reads require App membership; authoring, publication, and Metric deletion require App admin or
owner. PAT permissions are `read`, `write`, and `delete` respectively.

## Event Definition endpoints

### `GET /apps/{app_id}/event-definitions`

Returns App-scoped `ListResponse<EventDefinition>`.

### `POST /apps/{app_id}/event-definitions`

Body:

```typescript
{
  name: string; // stable SDK eventName; unique per App
  family: "metric" | "web"; // immutable
  displayName: string;
  description?: string;
  idempotency_key?: string;
}
```

Returns the Event Definition with `state: "draft"` and `currentPublishedVersionId: null`.
Creating the definition does not create an implicit schema. A legacy Metric migration instead
reports `state: "incomplete"`: the Event binding is preserved for edits, but the operator must
publish a complete schema before the Event Definition can accept Metric Events.

### `GET /apps/{app_id}/event-definitions/{event_definition_id}`

Returns the Event Definition plus its published version summaries.

### `PATCH /apps/{app_id}/event-definitions/{event_definition_id}`

Body may update `displayName` and `description` only. `name` is stable after creation because it is
the SDK event key. `family` is also stable because it selects the wire contract, validation branch,
and physical datasource.

### `POST /apps/{app_id}/event-definitions/{event_definition_id}/versions`

Atomically creates and publishes the next immutable version. The parent family selects one of two
strict request branches:

```typescript
type NumberKind = "measurement" | "count" | "amount" | "duration" | "ratio" | "score" | "delta";

type NumericDomain =
  | {
      allowedValues: number[];
      minimum?: never;
      maximum?: never;
    }
  | {
      allowedValues?: never;
      minimum: number;
      maximum: number;
    };

type ScalarDefinitionRequest =
  | {
      name: string;
      type: "boolean";
      required: boolean;
      allowedValues?: boolean[];
    }
  | {
      name: string;
      type: "string";
      required: boolean;
      allowedValues: string[];
    }
  | ({
      name: string;
      type: "number";
      required: boolean;
      numberKind: NumberKind;
    } & NumericDomain);

type EventFieldDefinitionRequest =
  | ScalarDefinitionRequest
  | {
      name: string;
      type: "json";
      required: boolean;
      jsonSchema: ClosedJsonSchema;
    };

type MetricEventDefinitionVersionRequest = {
  entityType: string; // required identity
  fields: EventFieldDefinitionRequest[];
  dimensions: ScalarDefinitionRequest[];
  idempotency_key?: string;
};

type WebEventDefinitionVersionRequest = {
  entityType: string | null; // null prohibits identity; string permits matching optional identity
  fields: MetricEventDefinitionVersionRequest["fields"];
  dimensions: MetricEventDefinitionVersionRequest["dimensions"];
};
```

The Worker enforces unique field names, unique Dimension names, disjoint sets, a JSON Schema only for
`type = "json"`, and `additionalProperties: false` at every object node. An `allowedValues` list
must be non-empty, unique, and exactly match its scalar declaration; it is required for every string
field or Dimension, one valid numeric-domain branch, and prohibited on a JSON field, whose every
string node requires a JSON Schema `enum`. Every number declares `numberKind` and either a numeric
allowlist or both finite bounds; recursive JSON number nodes declare the equivalent `numberKind` and
`enum` or bounds. String values must be bounded machine tokens, and top-level or nested property
names matching the direct-PII denylist fail publication. The exact token and denylist rules live in
[leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md#closed-json-schema). Allowlists
participate in `schemaHash`.

`ClosedJsonSchema` is the exact recursive subset defined in
[leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md#closed-json-schema). Unknown schema
keywords, references, composition, open object nodes, and malformed bounds fail publication with
`VALIDATION_ERROR`; the API does not accept an arbitrary JSON Schema document.

`minimum` and `maximum` are the required pair when a number has no numeric allowlist. They are finite
and inclusive, cannot be combined with a numeric allowlist, and are invalid on non-number
declarations. Publication rejects `minimum > maximum`. `numberKind` and numeric domains participate
in `schemaHash`.

The Worker assigns the dense version ordinal, computes `schemaHash`, inserts the version, and
advances `currentPublishedVersionId` in one transaction.

Returns the published `EventDefinitionVersion`.

The shared version resource dispatches by the parent Event Definition's family. A `metric` version
rejects null `entityType`. A `web` version requires either explicit null for an anonymous-only
definition or a non-empty Entity type. Clients cannot submit or override `family` on a version
request.

For built-in browser adapters, `@splitch/contracts` exports canonical `page_view`, `web_vital`, and
`browser_error` templates containing the required fields and Dimensions. The control panel and CLI
may prefill this same existing request from a template after the user chooses the definition's name,
display metadata, and Entity policy. The API receives and validates the fully expanded ordinary
request; it does not accept a template selector, infer a schema, or expose another endpoint.

Published versions have `GET` and list routes but no PATCH or independent DELETE route:

- `GET /apps/{app_id}/event-definitions/{event_definition_id}/versions`
- `GET /apps/{app_id}/event-definitions/{event_definition_id}/versions/{version_id}`

An App delete removes definitions only through the normal App data-purge workflow after dependent
Metric Events and Web Events are purged. V1 has no standalone Event Definition delete because
historical accepted rows must remain traceable to their version.

## Metric endpoints

### `GET /apps/{app_id}/metrics`

Returns App-scoped `ListResponse<Metric>`.

### `POST /apps/{app_id}/metrics`

Body:

```typescript
{
  key: string;
  name: string;
  description?: string;
  kind: "binomial" | "count" | "revenue" | "ratio" | "retention";

  appId: string;
  // Required for binomial/count/revenue/retention; absent for ratio.
  eventDefinitionId?: string;

  // Required for count/revenue. Must be a declared top-level number field.
  eventFieldName?: string;

  // Required for ratio. Both must name distinct same-App non-Ratio Metrics; cycles rejected.
  numerator?: MetricRef;
  denominator?: MetricRef;

  // Required for retention. Window is [anchor + horizonStartMs, anchor + horizonEndMs).
  horizonStartMs?: number;
  horizonEndMs?: number;

  idempotency_key?: string;

  // Analysis knobs. Null means "engine default"; Run Start resolves each one and
  // freezes the answer on the Run. Every threshold below is a percent.
  winsorize?: boolean | null;         // rejected on binomial and retention: 0/1 has no tail to cap
  winsorizePct?: number | null;      // > 0, <= 100
  cuped?: boolean | null;             // ignored on ratio: the delta method is never CUPED-adjusted
  cupedCoverageThresholdPct?: number | null;  // > 0, <= 100
  downsideThresholdPct?: number | null;    // set to make this a Guardrail Metric
  direction?: "higher_is_better" | "lower_is_better" | null;  // which way a move is good; null reads as neutral
}
```

The Worker resolves the current published Event Definition Version before writing a Metric that
directly references an Event Definition. The Event Definition must have `family = "metric"`:

- Binomial and Retention reference the definition and leave `eventFieldName` absent. Retention
  also requires `horizonStartMs` and `horizonEndMs` (`end > start`).
- Count and Revenue reference a declared `number` field by exact name on that published version.
  JSON paths and expressions are rejected.
- Ratio references two same-App non-Ratio, non-Retention Metrics with distinct ids, rejects Ratio
  and Retention operands and dependency cycles, and carries no direct Event Definition or field.

Metrics store `event_definition_id` (not a pinned version). Create and patch validate the field
contract against the then-current published version. Analysis never re-resolves fields from the
current version: each Metric Event row supplies its accepting immutable
`event_definition_version_id`, and field name/type are taken from that stamped version so Runs that
span versions remain lossless after later measurement edits. A later publish that removes or retypes
a referenced field rejects new Metric create/patch and new ingest against the current version; it
does not rewrite already-accepted rows.

Metric responses include `configurationStatus = ready`. A Ratio migrated from the former direct
Event Definition shape has `configurationStatus = needs_configuration`, keeps its former binding
visible for diagnosis, and remains readable through the SDK and Control Panel. Run Start rejects it
until an operator supplies distinct numerator and denominator Metrics; that repair clears the legacy
direct binding instead of inferring an operand.

Returns the canonical `Metric`. Ratio operands are `MetricRef` objects such as
`{ metricId: string }`, as defined by `MetricRefSchema`. Conversion Window belongs to the
Experiment, not to Metric create or patch.

### `GET /apps/{app_id}/metrics/{metric_id}`

### `PATCH /apps/{app_id}/metrics/{metric_id}`

The patch schema accepts `kind`, but the Worker refuses a change to the stored kind with
`VALIDATION_ERROR`. Other create fields except `appId` and `idempotency_key` are patchable subject
to the same cross-field validation. A migrated
Metric may update metadata and analysis settings while its Event Definition is `incomplete`, but it
cannot change that Event binding until the operator publishes a complete schema. A patch is
a measurement edit and recomputes over canonical logical facts from `serve_deduped_exposures` and
`serve_deduped_metric_events`; it never returns `RUN_FROZEN`. The append-only physical logs remain
replay and reconciliation truth, not direct request-time serving inputs. If the Metric is in a
running Run's locked decision family, changing its decision-valid contract returns
`DECISION_LOCKED`; exploratory views may still use the proposed definition separately.

### `DELETE /apps/{app_id}/metrics/{metric_id}`

Blocked while any **running** Experiment references it (`EXPERIMENT_RUNNING`). Draft or ended
Experiments that still name the Metric do not use that code — delete succeeds so a finished Run
cannot trap Metric (and therefore Flag/App) cleanup. Start still freezes Metric refs into the Run;
callers that delete a Metric a draft still names will fail loud at Start rather than on delete.

## Entity compatibility guard

When a Metric is attached to an Experiment and again when a Run starts, the Worker resolves every
referenced Event Definition's current published version. Its `entityType` must equal the
Experiment/Run `targeting_key_type`. A mismatch returns `400 ENTITY_TYPE_MISMATCH` and writes no
Experiment, Run, or Metric-reference mutation.

The Analysis Worker joins Metric Events only when all of these match the Run's first-touch Exposure
set: `app_id`, `environment_id`, `id_type = runs.targeting_key_type`, and `targeting_key_hash`. A
Metric Event can remain a valid App/Environment fact even when it is incompatible with a particular
Run.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../contracts/leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md)
- [../contracts/leaf-schemas-experiment.md](../contracts/leaf-schemas-experiment.md)
- [../pipeline/metric-event-contract.md](../pipeline/metric-event-contract.md)
