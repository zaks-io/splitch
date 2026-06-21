# Test-evaluation endpoint: `POST /apps/:appId/envs/:environmentId/flags/:flagId/test-eval` (control-plane dry-run)

Resolves a Variant and its reason without firing an Exposure. Used by CLI/MCP/agent for
pre-deploy verification and by humans for debugging. Categorically NOT the data-plane
evaluate endpoint (ADR-0026).

## Categorical distinction from `POST /evaluate`

| Property | `POST /evaluate` (data plane) | `POST /test-evaluation` (control plane) |
|----------|------------------------------|----------------------------------------|
| Credential | Client Key (public) | Control-plane token (ADR-0022) |
| Fires Exposure | Yes (structural) | Never (structural) |
| Returns reason | No (ADR-0018) | Yes |
| Writes to Assignment Store | Via pipeline | Never |
| Counts in Run denominator | Yes | Never |
| Use case | Production SDK calls | Debugging, CLI verify step, agent pre-deploy |

Exposure-free is **structural** at the endpoint level — the Worker code path from
`/test-evaluation` is wired to no write path (no Exposure log append, no DO call).
There is no "suppress Exposure" flag a caller could accidentally omit (ADR-0026).

## Endpoint

```
POST /apps/:appId/envs/:environmentId/flags/:flagId/test-eval
Authorization: Bearer <controlPlaneToken>   -- ADR-0022, NOT a Client/API Key
Content-Type: application/json
```

The Environment is in the path (`environmentId`, ADR-0027): the dry-run resolves against that
Environment's live config, mirroring how the data-plane resolves the Environment from the Client Key.

## Request shape

```
TestEvaluationRequest {
  flagKey:           string     -- required
  targetingKey:      string     -- required
  idType:            string     -- required; must match Experiment's pinned idType
  evaluationContext: {
    targetingKey: string        -- must equal top-level targetingKey
    [key: string]: unknown      -- arbitrary attributes for Targeting Rule matching
  }
}
```

## Response shape

```
TestEvaluationResponse {
  variant: VariantValue     -- resolved Variant value (same type as evaluate endpoint)
  reason:  EvaluationReason
}

EvaluationReason =
  | {
      type: 'rule_matched'
      ruleId: string
      ruleName: string
      priority: number
      selection: 'direct' | 'percentage_rollout'
      rollout?: { variantWeights: { variantName: string; weight: number }[] }
    }
  | { type: 'default_disabled' }    -- Flag is disabled; Default Variant returned
  | { type: 'no_match_default' }    -- No Targeting Rule matched; Default Variant returned
```

`reason` is a Zod discriminated union. The three cases are exhaustive —
every evaluation produces exactly one. Rule details (`ruleId`, `ruleName`, `priority`,
`selection`) identify which Targeting Rule matched without exposing hash bucket or salt.

## What it NEVER does

- Fires an Exposure to the raw log
- Writes to the Assignment Store (DO or KV)
- Reads or replays holdovers from the Assignment Store
- Counts the Entity in any Run's analysis denominator
- Returns the full Targeting Rule conditions or Percentage Rollout configuration
- Returns hash bucket or salt

The endpoint reads the same live edge config the data-plane `evaluate` endpoint uses, so
the result reflects the current deployed state (ADR-0026). A 60s KV
propagation window applies equally here — the resolve uses the same KV-cached config.

## Live config consistency

Test-evaluation resolves against the **same KV-backed Provider config path the data-plane
`evaluate` endpoint reads** — not D1 directly. This is deliberate: ADR-0026's purpose is to
"verify the deployed truth," and the deployed truth is what the edge serves. Reading D1 (which
updates synchronously on Start) would let the dry-run report a Variant the data plane cannot
yet serve, misleading the agent's verify step.

Consequence: after Start, both test-evaluation and the data-plane endpoint observe the new
config within the same ~60s KV propagation window (ADR-0009). The verify step is honest about
propagation — if it shows the old Variant for a few seconds after Start, so does production.

## Error responses

Same `ErrorResponse` shape as all endpoints (ADR-0025):

| HTTP status | `code` | Meaning |
|------------|--------|---------|
| 401 | `INVALID_CREDENTIAL` | Missing or invalid control-plane token |
| 403 | `FORBIDDEN` | Token does not have access to this appId |
| 404 | `FLAG_NOT_FOUND` | flagKey does not exist in this App |
| 422 | `VALIDATION_ERROR` | Request body failed Zod parse |

## CLI / MCP surface

This endpoint is exposed as:
- One MCP tool: `splitch_test_evaluation` with schema derived from the Zod request shape
- One CLI command: `splitch verify flag <flagKey> --context <json>`

Both are thin skins over the same endpoint (ADR-0023). The agent's verify step calls this
endpoint immediately after configuring or promoting a Flag, or after starting an Experiment Run, to confirm the rule set
resolves as expected.

## Seam boundary

- **Port:** `testEvaluate(appId, environmentId, controlPlaneToken, flagKey, targetingKey, idType, evaluationContext) -> { variant, reason }`
- **Left side:** CLI / MCP / agent calling the verify step; control-plane token required
- **Right side:** Worker that reads live config from the same KV-backed Provider path the data-plane `evaluate` endpoint uses (not D1 directly), computes Assignment, returns reason; wired to NO write path
- **Failure contract:** no writes on error; 404 → flag not found; 401/403 → auth failure
- **Deletion test:** passes — test-evaluation and data-plane evaluate are two real adapters
  on the "resolve a Variant" port, differing in auth, exposure side effect, and reason return

## Sources

- [ADR-0026](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
