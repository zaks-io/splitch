# Request/response envelopes: conventions and evaluate endpoints

Shared envelope conventions (create/patch asymmetry, pagination) plus the dry-run test-evaluate and
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

### TestEvaluationRequest

| Field | Required | Notes |
|---|---|---|
| `flagKey` | yes | Identifies the Flag |
| `targetingKey` | yes | The Entity identifier; separate from `attributes` (spec contract) |
| `idType` | yes | Entity type; must match Experiment's `targetingKey` entity type |
| `attributes` | no | `Record<string, boolean \| string \| number \| unknown[]>`; Condition-matching attributes; defaults to `{}` |

Internally the Worker adds `targetingKey` to context under a reserved key before Condition evaluation.

### TestEvaluationResponse

```
{
  variantName: string
  variantId:   string
  reason:      TestEvaluationReason
  allRules:    TargetingRule[]  // ordered by priority; for UI rule-step debugging
}
```

`TestEvaluationReason` is a Zod discriminated union:

```
TestEvaluationReason =
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
through Percentage Rollout.
No Exposure-related fields. Writes nothing.

---

## Data-plane evaluate endpoint (SDK, Client Key)

### DataPlaneEvaluateRequest

| Field | Required | Notes |
|---|---|---|
| `flagKey` | yes | — |
| `targetingKey` | yes | — |
| `idType` | yes | — |
| `attributes` | no | Defaults to `{}` |

### DataPlaneEvaluateResponse

```
{
  variantName: string | null  // null if Flag not found or disabled and no Default Variant
  variantId:   string | null
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
