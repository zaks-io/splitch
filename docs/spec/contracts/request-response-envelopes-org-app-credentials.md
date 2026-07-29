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

| Field         | Required | Notes                                  |
| ------------- | -------- | -------------------------------------- |
| `appId`       | yes      | —                                      |
| `name`        | yes      | Stable SDK `eventName`; unique per App |
| `displayName` | yes      | —                                      |
| `description` | no       | —                                      |

### CreateEventDefinitionVersionRequest

| Field               | Required | Notes                                                       |
| ------------------- | -------- | ----------------------------------------------------------- |
| `appId`             | yes      | —                                                           |
| `eventDefinitionId` | yes      | Must belong to `appId`                                      |
| `entityType`        | yes      | Required inbound Metric Event `idType`                      |
| `fields`            | yes      | `EventFieldDefinition[]`; JSON fields require closed schema |
| `dimensions`        | yes      | `DimensionDefinition[]`; scalar only                        |

The Worker assigns the version and stamps publication metadata. No request can supply
`version`, `schemaHash`, `publishedAt`, or `publishedBy`.

---

## Metric endpoints

### CreateMetricRequest

| Field                | Required | Notes                                               |
| -------------------- | -------- | --------------------------------------------------- |
| `appId`              | yes      | —                                                   |
| `name`               | yes      | —                                                   |
| `key`                | yes      | Unique per App                                      |
| `kind`               | yes      | `'binomial' \| 'count' \| 'revenue' \| 'ratio'`     |
| `eventDefinitionId`  | cond.    | Required except for ratio; same App                 |
| `eventFieldName`     | cond.    | Declared top-level number field; count/revenue only |
| `numerator`          | cond.    | Ratio only; `{ metricId }`, same App, non-Ratio     |
| `denominator`        | cond.    | Ratio only; `{ metricId }`, same App, non-Ratio     |
| `conversionWindowMs` | no       | Null/absent inherits Experiment default             |
| `winsorize`          | no       | Type-specific default                               |
| `winsorizePct`       | no       | Default 99.9                                        |
| `description`        | no       | —                                                   |

### PatchMetricRequest

All fields optional. No Run-frozen check — Metric patches are measurement edits that recompute over
the existing Run (ADR-0003). Never returns `RUN_FROZEN`.

| Field                | Required |
| -------------------- | -------- |
| `name`               | no       |
| `key`                | no       |
| `eventDefinitionId`  | no       |
| `eventFieldName`     | no       |
| `numerator`          | no       |
| `denominator`        | no       |
| `conversionWindowMs` | no       |
| `winsorize`          | no       |
| `winsorizePct`       | no       |
| `description`        | no       |

`kind` is immutable. The Worker validates the complete post-patch object, so a partial patch cannot
leave an invalid combination. No field accepts a JSON path or expression.

---

## App / Org / Credential endpoints

### CreateAppRequest

| Field            | Required |
| ---------------- | -------- |
| `organizationId` | yes      |
| `name`           | yes      |
| `key`            | yes      |
| `description`    | no       |

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

Returns `(APIKey | ClientKey)[]`. API Key responses never include a raw secret value. Client Key
responses include `keyMaterial`.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
