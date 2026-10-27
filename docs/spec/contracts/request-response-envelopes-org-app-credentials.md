# Request/response envelopes: Event Definition, Metric, App, Org, and Credential endpoints

Wire shapes for Event Definition, Metric, App/Org, and SDK credential control-plane endpoints,
including immutable version creation, API Key once-only surfacing, and public Client Key retrieval.

Envelopes compose leaf schemas from [leaf-schemas-runtime.md](./leaf-schemas-runtime.md) and
[leaf-schemas-experiment.md](./leaf-schemas-experiment.md). They are **distinct** — never fused. Shared
conventions live in [request-response-envelopes-conventions.md](./request-response-envelopes-conventions.md).
(ADR-0025 "reuse at the leaf".)

---

## Event Definition endpoints

### CreateEventDefinitionRequest

`appId` is a path parameter, not a body field. MCP flattens it alongside the body.

| Field             | Required | Notes                                       |
| ----------------- | -------- | ------------------------------------------- |
| `name`            | yes      | Stable event name; unique per App           |
| `family`          | yes      | Immutable `'metric' \| 'web'` selected once |
| `displayName`     | yes      | —                                           |
| `idempotency_key` | no       | Exact retry identity                        |
| `description`     | no       | —                                           |

### CreateEventDefinitionVersionRequest (`PublishEventDefinitionVersionRequestSchema`)

The path supplies `appId` and `eventDefinitionId`. The parent supplies immutable `family`; the
strict version body cannot override it. The Worker checks the family-dependent `entityType`:

| Field             | Required | Notes                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------------- |
| `idempotency_key` | no       | Exact retry identity                                                                        |
| `entityType`      | yes      | `metric`: non-empty string; `web`: non-empty string or explicit null                        |
| `fields`          | yes      | `EventFieldDefinition[]`; strings are allowlisted; numbers have kind/domain; JSON is closed |
| `dimensions`      | yes      | `DimensionDefinition[]`; strings are allowlisted; numbers have kind/domain                  |

The Worker assigns the version and stamps publication metadata. No request can supply
`version`, `schemaHash`, `publishedAt`, or `publishedBy`.

For a `web` version, `entityType: null` prohibits Entity identity. A non-empty value allows either
anonymous events or a complete identity pair whose `idType` matches. For a `metric` version, identity
is always required.

An `allowedValues` list is required for string fields and Dimensions, optional for boolean, and one
of the two valid numeric-domain branches. Every number declares `numberKind` and either a non-empty
numeric `allowedValues` list or both finite bounds. Every recursive JSON number node follows the same
rule with `enum`; every JSON string node requires an `enum`. String allowlists contain only bounded
machine tokens, and direct-PII property names fail publication. These constraints participate in
`schemaHash`.

`minimum` and `maximum` are the required pair for the bounded numeric-domain branch. They are
inclusive and finite, are invalid on non-number declarations, reject `minimum > maximum`, cannot be
combined with a numeric allowlist, and participate in `schemaHash`.

---

## Metric endpoints

### CreateMetricRequest

| Field                       | Required | Notes                                                          |
| --------------------------- | -------- | -------------------------------------------------------------- |
| `appId`                     | yes      | —                                                              |
| `name`                      | yes      | —                                                              |
| `key`                       | yes      | Unique per App                                                 |
| `kind`                      | yes      | `'binomial' \| 'count' \| 'revenue' \| 'ratio' \| 'retention'` |
| `eventDefinitionId`         | cond.    | Required except for ratio; same App                            |
| `eventFieldName`            | cond.    | Declared top-level number field; count/revenue only            |
| `numerator`                 | cond.    | Ratio only; `{ metricId }`, same App, non-Ratio                |
| `denominator`               | cond.    | Ratio only; `{ metricId }`, same App, non-Ratio                |
| `horizonStartMs`            | cond.    | Retention only                                                 |
| `horizonEndMs`              | cond.    | Retention only; greater than `horizonStartMs`                  |
| `winsorize`                 | no       | Type-specific default                                          |
| `winsorizePct`              | no       | Default 99.9                                                   |
| `direction`                 | no       | `higher_is_better`, `lower_is_better`, or null                 |
| `downsideThresholdPct`      | no       | Guardrail harm threshold, or null                              |
| `cuped`                     | no       | Null/absent selects engine default true                        |
| `cupedCoverageThresholdPct` | no       | > 0 and <= 100; null/absent selects 70                         |
| `idempotency_key`           | no       | Exact retry identity                                           |
| `description`               | no       | —                                                              |

### PatchMetricRequest

All fields optional. No Run-frozen check — Metric patches are measurement edits that recompute over
the existing Run (ADR-0003). Never returns `RUN_FROZEN`.

| Field                       | Required |
| --------------------------- | -------- |
| `kind`                      | no       |
| `name`                      | no       |
| `key`                       | no       |
| `eventDefinitionId`         | no       |
| `eventFieldName`            | no       |
| `numerator`                 | no       |
| `denominator`               | no       |
| `winsorize`                 | no       |
| `winsorizePct`              | no       |
| `horizonStartMs`            | no       |
| `horizonEndMs`              | no       |
| `direction`                 | no       |
| `downsideThresholdPct`      | no       |
| `cuped`                     | no       |
| `cupedCoverageThresholdPct` | no       |
| `description`               | no       |

The schema accepts `kind` so the Worker can explain its immutability; changing it is rejected. The Worker validates the complete post-patch object, so a partial patch cannot
leave an invalid combination. No field accepts a JSON path or expression.

---

## App / Org / Credential endpoints

### CreateAppRequest

The owning `orgId` is a path parameter, not a body member.

| Field             | Required                          |
| ----------------- | --------------------------------- |
| `name`            | yes                               |
| `key`             | no; derived from name when absent |
| `description`     | no                                |
| `idempotency_key` | no                                |

### CreateAppResponse

Surfaces the App plus the two default Environments (`dev`, `prod`) and their public Client Keys. API
Keys are not auto-provisioned here; they are minted through the per-Environment API Key endpoint.

```
{
  app:          App
  environments: [Environment, Environment]
  clientKeys:   [ClientKey, ClientKey] // public Client Keys, safe to embed client-side
}
```

### CreateCredentialResponse (generic, for standalone key create)

```
{
  credential: APIKey | ClientKey
  value:      string         // API Key: once only; Client Key: same as keyMaterial
}
```

### ListCredentialsResponse

```
{
  items: (APIKey | ClientKey)[]
  readLimit: positive integer
  readTruncated: boolean
  cursor: string | null
}
```

List responses never include a raw API Key value. Client Key responses include `keyMaterial`.
`readTruncated` reports whether the bounded read omitted additional keys, `readLimit` reports
that bound, and `cursor` is present-with-null because this list is not paginated.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
