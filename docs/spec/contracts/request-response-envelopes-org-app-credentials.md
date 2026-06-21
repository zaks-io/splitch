# Request/response envelopes: Metric, App, Org, and Credential endpoints

Wire shapes for Metric, App/Org, and SDK credential control-plane endpoints, including API Key
once-only surfacing and public Client Key retrieval.

Envelopes compose leaf schemas from [leaf-schemas-runtime.md](./leaf-schemas-runtime.md) and
[leaf-schemas-experiment.md](./leaf-schemas-experiment.md). They are **distinct** — never fused. Shared
conventions live in [request-response-envelopes-conventions.md](./request-response-envelopes-conventions.md).
(ADR-0025 "reuse at the leaf".)

---

## Metric endpoints

### CreateMetricRequest

| Field             | Required | Notes                                                    |
| ----------------- | -------- | -------------------------------------------------------- |
| `appId`           | yes      | —                                                        |
| `name`            | yes      | —                                                        |
| `key`             | yes      | Unique per App                                           |
| `kind`            | yes      | `'binomial' \| 'count' \| 'revenue' \| 'ratio'`          |
| `eventName`       | yes      | —                                                        |
| `eventValueField` | no       | Required for `count`/`revenue`; validated by Worker      |
| `denominator`     | no       | Required for `ratio`; `{ metricId }` must be in same App |
| `description`     | no       | —                                                        |

### PatchMetricRequest

All fields optional. No Run-frozen check — Metric patches are measurement edits that recompute over
the existing Run (ADR-0003). Never returns `RUN_FROZEN`.

| Field             | Required |
| ----------------- | -------- |
| `name`            | no       |
| `key`             | no       |
| `kind`            | no       |
| `eventName`       | no       |
| `eventValueField` | no       |
| `denominator`     | no       |
| `description`     | no       |

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

Surfaces the API Key raw value **once only**. The Client Key value is public and remains retrievable.
A new App is seeded with a default Environment; the returned credentials belong to that Environment
(ADR-0027). Per-Environment credentials are minted via the
`/apps/{app_id}/envs/{environment_id}/client-key | api-keys` endpoints.

```
{
  app:           App                  // full App leaf
  environmentId: string               // the seeded default Environment the keys belong to
  apiKey:        { id, value: string } // raw value; store it now
  clientKey:     { id, value: string } // raw value; safe to embed client-side
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
