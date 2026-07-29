# Control-plane endpoints: Event Definition and Metric

Request/response shapes for App-level Event Definitions, immutable published versions, and Metrics.
All endpoints live on the Control Plane API Worker and require a control-plane bearer token.
Requests/responses are `Content-Type: application/json`. Shared errors and pagination are defined in
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
the SDK event key.

### `POST /apps/{app_id}/event-definitions/{event_definition_id}/versions`

Atomically creates and publishes the next immutable version:

```typescript
{
  entity_type: string;
  fields: Array<{
    name: string;
    type: "boolean" | "string" | "number" | "json";
    required: boolean;
    json_schema?: ClosedJsonSchema;
  }>;
  dimensions: Array<{
    name: string;
    type: "boolean" | "string" | "number";
    required: boolean;
  }>;
}
```

The Worker enforces unique field names, unique Dimension names, disjoint sets, a JSON Schema only for
`type = "json"`, and `additionalProperties: false` at every object node. It assigns the dense version
ordinal, computes `schema_hash`, inserts the version, and advances
`current_published_version_id` in one transaction.

Returns the published `EventDefinitionVersion`.

Published versions have `GET` and list routes but no PATCH or independent DELETE route:

- `GET /apps/{app_id}/event-definitions/{event_definition_id}/versions`
- `GET /apps/{app_id}/event-definitions/{event_definition_id}/versions/{version_id}`

An App delete removes definitions only through the normal App data-purge workflow after dependent
Metric Events are purged. V1 has no standalone Event Definition delete because historical accepted
rows must remain traceable to their version.

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

  // Required for ratio. Both must name non-Ratio Metrics in the same App.
  numerator_metric_id?: string;
  denominator_metric_id?: string;

  conversion_window_ms?: number;
  winsorize?: boolean;
  winsorize_pct?: number;
}
```

The Worker resolves the current published Event Definition Version before writing:

- Binomial references the definition and leaves `event_field_name` absent.
- Count and Revenue reference a declared `number` field by exact name. JSON paths and expressions
  are rejected.
- Ratio references two same-App non-Ratio Metrics and carries no direct Event Definition or field.

Returns the canonical `Metric`.

### `GET /apps/{app_id}/metrics/{metric_id}`

### `PATCH /apps/{app_id}/metrics/{metric_id}`

All create fields except `kind` are patchable subject to the same cross-field validation. A patch is
a measurement edit and recomputes over raw facts; it never returns `RUN_FROZEN`. If the Metric is in
a running Run's locked decision family, changing its decision-valid contract returns
`DECISION_LOCKED`; exploratory views may still use the proposed definition separately.

### `DELETE /apps/{app_id}/metrics/{metric_id}`

Blocked while any active Experiment references it.

## Entity compatibility guard

When a Metric is attached to an Experiment and again when a Run starts, the Worker resolves every
referenced Event Definition's current published version. Its `entity_type` must equal the
Experiment/Run `targeting_key_type`. A mismatch returns `400 ENTITY_TYPE_MISMATCH` and writes no
Experiment, Run, or Metric-reference mutation.

The Analysis Worker repeats this condition when joining Metric Events:
`metric_events.id_type = runs.targeting_key_type`. A Metric Event can remain a valid App/
Environment fact even when it is not compatible with a particular Run.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../contracts/leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md)
- [../contracts/leaf-schemas-experiment.md](../contracts/leaf-schemas-experiment.md)
- [../pipeline/metric-event-contract.md](../pipeline/metric-event-contract.md)
