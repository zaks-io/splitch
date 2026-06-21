# Test-evaluation endpoint — dry-run, never exposes

Resolves a Flag against live config and returns the Variant plus the reason. Writes nothing.
No Exposure fires. No Assignment Store write. Exposure-free is structural, not a parameter.
The Assignment Store may be read to report `holdover_replay`.

## Purpose

Verify that a Flag resolves correctly end-to-end — before deploying the customer's service
and before polluting Experiment data. The CLI verify command, MCP test-evaluation tool, and
the human debugger are three skins over this one endpoint. (ADR-0023.)

## Authorization

Control-plane token (ADR-0022). Not a Client Key or API Key. The reason field (which rule
matched) is restricted from the public data-plane endpoint (ADR-0018 prohibits returning
rule-set/salt/config on the Client-Key path). This endpoint lives behind the control-plane
auth surface.

## Request shape

```
POST /apps/:appId/envs/:environmentId/flags/:flagId/test-eval

{
  "evaluationContext": {
    "targetingKey": string,
    "idType": string,
    "attributes": Record<string, boolean | string | number | unknown[]>
  }
}
```

No `runId` parameter. Always evaluates against the current live Run **of the path's Environment**
(`environment_id`, ADR-0027). If no Run is live, behaves as if Flag is disabled.

## Response shape

```
{
  "variantName": string,       // resolved Variant name
  "value": VariantValue,       // resolved Variant value, same value the SDK would receive
  "reason": ReasonDetail,      // why this Variant was chosen (discriminated union)
  "liveRunId": string | null   // live Run observed from KV; null if no Run is live
}
```

## Reason discriminated union

```
type ReasonDetail =
  | {
      type: 'holdover_replay'
      priorRunId: string // Run that owns this Entity's sticky experience
    }
  | {
      type: 'rule_matched'
      ruleId:   string    // stable rule identity
      ruleName: string | null // human-readable label
      priority: number    // lower = higher priority; the priority of the matched rule
      selection: 'direct' | 'percentage_rollout'
      rollout?: {         // present if the rule used Fractional Evaluation
        variantWeights: { variantName: string; weight: number }[]
      }
    }
  | {
      type: 'default_disabled'
      // Flag.enabled is false; Default Variant returned.
    }
  | {
      type: 'no_match_default'
      // All Targeting Rules evaluated; none matched; Default Variant returned.
    }
```

The `reason` type is a Zod discriminated union (ADR-0025, Zod-first). Both skins (CLI, MCP)
render from the same contract type. The reason cases are exhaustive.

The response never exposes hash bucket, salt, or condition internals. `selection` tells the
debugger whether the matched rule selected a direct Variant or used Percentage Rollout.
`holdover_replay` tells the agent that the returned Variant came from prior Run sticky experience,
not from current Targeting Rule evaluation.

## Exposure-free contract (structural)

The endpoint has **no code path** to:

- The Exposure log
- The Assignment Store (`put()`)
- Any `runId` stamping

This is enforced at the Worker level (ADR-0023's invariant-in-the-Worker rule). It is not a
suppressible flag the caller can forget — the endpoint simply has no write wiring. A
test-evaluation row is **never** counted in an Experiment's denominator.

The Assignment Store `getAll()` **may** be read (to detect and report if the Entity is a
holdover, as diagnostic information). Even on the holdover path, `put()` is never called.

## Live config read path

The endpoint reads from the same KV-backed Provider cache the data-plane SDK reads. It does
not read from D1 directly (that would diverge from the live edge truth). The live Run is
whatever the edge would evaluate if the SDK made a real call at this moment.

~60s KV propagation window applies: immediately after Start, the endpoint may briefly
resolve against the old config. This is acknowledged and consistent with data-plane behavior
(ADR-0009). The endpoint documents this in its response: `liveRunId` reflects what was
actually evaluated.

## Error contract

| Condition                               | HTTP status | Detail                                                                                           |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| Flag not found for appId                | 404         | `{ error: 'FLAG_NOT_FOUND' }`                                                                    |
| No live Run (Experiment is draft)       | 200         | `variantName = defaultVariant.name`, `reason = { type: 'default_disabled' }`, `liveRunId = null` |
| Invalid flagId / missing required field | 400         | Zod validation error shape                                                                       |
| Auth failure                            | 401/403     | Control-plane token invalid or insufficient scope                                                |

## Seam boundary

**What's on this side (test-evaluation endpoint):** evaluate for debug/verify purposes;
return `(variantName, value, reason, liveRunId)`; write nothing.

**What's NOT here:** Exposure firing, Assignment Store writes, data returned to the
production SDK.

**Deletion test:** this is a single-implementation boundary deliberately. No swap needed —
the test-evaluation endpoint is the one control-plane endpoint for dry-run evaluation.
The exposure-free guarantee is its entire reason for existence.

**No superposition:** the caller always gets `(variantName, value, reason)`. There is no state where
"maybe an Exposure fired." The endpoint does not take a mode parameter.

## Sources

- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
