# Control-plane endpoints: Event Definition and Metric

Request/response shapes for the shared App-level Event Definition catalog, immutable published
versions, and Metrics. An Event Definition has one immutable `metric` or `web` family. All endpoints
live on the Control Plane API Worker and require a control-plane bearer token. Requests/responses
are `Content-Type: application/json`. Shared errors and pagination are defined in
[control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

Event Definitions and Metrics are App-level. Metric Events are per-Environment data-plane facts and
are accepted only by the Event Ingest Worker route in
[metric-event-contract.md](../pipeline/metric-event-contract.md).

## Event Definition endpoints

### `GET /apps/{app_id}/event-definitions`

Returns App-scoped `PaginatedResponse<EventDefinition>`.

### `POST /apps/{app_id}/event-definitions`

Body:

```typescript
{
  name: string; // stable SDK eventName; unique per App
  family: "metric" | "web"; // immutable
  display_name: string;
  description?: string;
}
```

Returns the Event Definition with `current_published_version_id: null`. Creating the definition does
not create an implicit schema.

### `GET /apps/{app_id}/event-definitions/{event_definition_id}`

Returns the Event Definition plus its published version summaries.

### `PATCH /apps/{app_id}/event-definitions/{event_definition_id}`

Body may update `display_name` and `description` only. `name` is stable after creation because it is
the SDK event key. `family` is also stable because it selects the wire contract, validation branch,
and physical datasource.

### `POST /apps/{app_id}/event-definitions/{event_definition_id}/versions`

Atomically creates and publishes the next immutable version. The parent family selects one of two
strict request branches:

```typescript
type NumberKind = "measurement" | "count" | "amount" | "duration" | "ratio" | "score" | "delta";

type NumericDomain =
  | {
      allowed_values: number[];
      minimum?: never;
      maximum?: never;
    }
  | {
      allowed_values?: never;
      minimum: number;
      maximum: number;
    };

type ScalarDefinitionRequest =
  | {
      name: string;
      type: "boolean";
      required: boolean;
      allowed_values?: boolean[];
    }
  | {
      name: string;
      type: "string";
      required: boolean;
      allowed_values: string[];
    }
  | ({
      name: string;
      type: "number";
      required: boolean;
      number_kind: NumberKind;
    } & NumericDomain);

type EventFieldDefinitionRequest =
  | ScalarDefinitionRequest
  | {
      name: string;
      type: "json";
      required: boolean;
      json_schema: ClosedJsonSchema;
    };

type MetricEventDefinitionVersionRequest = {
  entity_type: string; // required identity
  fields: EventFieldDefinitionRequest[];
  dimensions: ScalarDefinitionRequest[];
};

type WebEventDefinitionVersionRequest = {
  entity_type: string | null; // null prohibits identity; string permits matching optional identity
  fields: MetricEventDefinitionVersionRequest["fields"];
  dimensions: MetricEventDefinitionVersionRequest["dimensions"];
};
```

The Worker enforces unique field names, unique Dimension names, disjoint sets, a JSON Schema only for
`type = "json"`, and `additionalProperties: false` at every object node. An `allowed_values` list
must be non-empty, unique, and exactly match its scalar declaration; it is required for every string
field or Dimension, one valid numeric-domain branch, and prohibited on a JSON field, whose every
string node requires a JSON Schema `enum`. Every number declares `number_kind` and either a numeric
allowlist or both finite bounds; recursive JSON number nodes declare the equivalent `numberKind` and
`enum` or bounds. String values must be bounded machine tokens, and top-level or nested property
names matching the direct-PII denylist fail publication. The exact token and denylist rules live in
[leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md#closed-json-schema). Allowlists
participate in `schema_hash`.

`ClosedJsonSchema` is the exact recursive subset defined in
[leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md#closed-json-schema). Unknown schema
keywords, references, composition, open object nodes, and malformed bounds fail publication with
`VALIDATION_ERROR`; the API does not accept an arbitrary JSON Schema document.

`minimum` and `maximum` are the required pair when a number has no numeric allowlist. They are finite
and inclusive, cannot be combined with a numeric allowlist, and are invalid on non-number
declarations. Publication rejects `minimum > maximum`. `number_kind` and numeric domains participate
in `schema_hash`.

The Worker assigns the dense version ordinal, computes `schema_hash`, inserts the version, and
advances `current_published_version_id` in one transaction.

Returns the published `EventDefinitionVersion`.

The shared version resource dispatches by the parent Event Definition's family. A `metric` version
rejects null `entity_type`. A `web` version requires either explicit null for an anonymous-only
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

Returns App-scoped `PaginatedResponse<Metric>`.

### `POST /apps/{app_id}/metrics`

Body:

```typescript
{
  key: string;
  name: string;
  description?: string;
  kind: "binomial" | "count" | "revenue" | "ratio";

  // Required for binomial/count/revenue; absent for ratio.
  event_definition_id?: string;

  // Required for count/revenue. Must be a declared top-level number field.
  event_field_name?: string;

  // Required for ratio. Both must name distinct same-App non-Ratio Metrics; cycles rejected.
  numerator_metric_id?: string;
  denominator_metric_id?: string;

  conversion_window_ms?: number;
  winsorize?: boolean;
  winsorize_pct?: number;
}
```

The Worker resolves the current published Event Definition Version before writing a Metric that
directly references an Event Definition. The Event Definition must have `family = "metric"`:

- Binomial references the definition and leaves `event_field_name` absent.
- Count and Revenue reference a declared `number` field by exact name on that published version.
  JSON paths and expressions are rejected.
- Ratio references two same-App non-Ratio Metrics with distinct ids, rejects Ratio operands and
  dependency cycles, and carries no direct Event Definition or field.

Metrics store `event_definition_id` (not a pinned version). Create and patch validate the field
contract against the then-current published version. Analysis never re-resolves fields from the
current version: each Metric Event row supplies its accepting immutable
`event_definition_version_id`, and field name/type are taken from that stamped version so Runs that
span versions remain lossless after later measurement edits. A later publish that removes or retypes
a referenced field rejects new Metric create/patch and new ingest against the current version; it
does not rewrite already-accepted rows.

Returns the canonical `Metric`.

### `GET /apps/{app_id}/metrics/{metric_id}`

### `PATCH /apps/{app_id}/metrics/{metric_id}`

All create fields except `kind` are patchable subject to the same cross-field validation. A patch is
a measurement edit and recomputes over canonical logical facts from `serve_deduped_exposures` and
`serve_deduped_metric_events`; it never returns `RUN_FROZEN`. The append-only physical logs remain
replay and reconciliation truth, not direct request-time serving inputs. If the Metric is in a
running Run's locked decision family, changing its decision-valid contract returns
`DECISION_LOCKED`; exploratory views may still use the proposed definition separately.

### `DELETE /apps/{app_id}/metrics/{metric_id}`

Blocked while any active Experiment references it.

## Entity compatibility guard

When a Metric is attached to an Experiment and again when a Run starts, the Worker resolves every
referenced Event Definition's current published version. Its `entity_type` must equal the
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
