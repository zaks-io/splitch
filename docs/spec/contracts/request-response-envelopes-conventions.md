# Request/response envelopes: conventions and evaluate endpoints

Shared envelope conventions (create/patch asymmetry, pagination) plus the dry-run test-evaluation and
public data-plane evaluate contracts.

Envelopes compose leaf schemas from the leaf-schemas files. They are **distinct** — never fused —
because create and patch have different required fields, and storage shapes carry internals (version,
audit) that must not leak to the wire. (ADR-0025 "reuse at the leaf".)

All envelopes are Zod schemas in `@splitch/contracts`. No field documented across the envelope files is
inferred or optional unless explicitly marked `no`.

Resource envelope files:

- [request-response-envelopes-flag-variant.md](./request-response-envelopes-flag-variant.md) — Flag and Variant endpoints
- [request-response-envelopes-experiment-run.md](./request-response-envelopes-experiment-run.md) — Experiment and Run endpoints
- [request-response-envelopes-org-app-credentials.md](./request-response-envelopes-org-app-credentials.md) — Metric, App, Org, and Credential endpoints

---

## Pagination wrapper (reused by all list endpoints)

```
PaginatedResponse<T> = {
  items:      T[]
  cursor:     string | null  // opaque; pass back as ?cursor= to fetch next page
  limit:      number         // the limit that was applied
  total:      number | null  // null when count is expensive (Tinybird endpoints)
}
```

---

## Test-evaluation endpoint (dry-run, control-plane token)

See also [mcp-tool-derivation.md](./mcp-tool-derivation.md) for the tool contract.

Route: `POST /apps/:appId/envs/:environmentId/flags/:flagId/test-eval`
MCP tool: `flags_test_eval`

### TestEvaluationRequest

| Field               | Required | Notes                                                                |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `evaluationContext` | yes      | `EvaluationContext` leaf: `targetingKey`, `idType`, and `attributes` |

The Flag is identified by `flagId` in the path. `EvaluationContext.targetingKey` is the Entity
identifier; `EvaluationContext.idType` must match the Experiment's configured Entity type.

### TestEvaluationResponse

```
{
  variantName: string
  value:       VariantValue
  reason:      TestEvaluationReason
  liveRunId:   string | null
}
```

`VariantValue = boolean | string | number | JsonObject`.
Test-evaluation returns both the Variant name and the resolved Variant value. Agents compare the
Variant name against Rules, Runs, Exposures, and analysis; clients receive the value on the public
SDK path. It does not return the full Targeting Rule set.

`TestEvaluationReason` is a Zod discriminated union:

```
TestEvaluationReason =
  | {
      type: 'holdover_replay'
      priorRunId: string
    }
  | {
      type: 'rule_matched'
      ruleId: string
      ruleName: string | null
      priority: number
      selection: 'direct' | 'percentage_rollout'
      rollout?: { variantWeights: { variantName: string; weight: number }[] }
    }
  | { type: 'default_disabled' } // Flag.enabled = false
  | { type: 'no_match_default' } // no rule matched; Default Variant served
```

No rollout bucket or salt details. `selection` says whether the matched rule selected directly or
through Percentage Rollout. `liveRunId` reflects the live Run observed from KV when the dry-run
resolved; it can be `null` when no Run is live.
No Exposure-related fields. Writes nothing.

---

## Data-plane evaluate endpoint (SDK, Client Key)

### DataPlaneEvaluateRequest

| Field          | Required | Notes            |
| -------------- | -------- | ---------------- |
| `flagKey`      | yes      | —                |
| `targetingKey` | yes      | —                |
| `idType`       | yes      | —                |
| `attributes`   | no       | Defaults to `{}` |

### DataPlaneEvaluateResponse

```
{
  variant: VariantValue | null  // null if Flag not found or disabled and no Default Variant
}
```

No `reason`. No rule set. No `salt`. No config. Safe under public Client Key (ADR-0018).
Peek uses a separate SDK path/endpoint with the same response shape and no Exposure side effect,
never a caller-supplied `deferExposure` flag.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
