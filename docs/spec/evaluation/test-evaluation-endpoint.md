# Test-evaluation endpoint — dry-run, never exposes

Resolves a Flag against live config and returns the Variant plus the reason. Writes nothing.
No Exposure fires. No Assignment Store write. Exposure-free is structural, not a parameter.

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
POST /api/v1/apps/:appId/test-evaluation

{
  "flagKey":        string,    // required; Flag to evaluate
  "targetingKey":   string,    // required; Entity identifier to evaluate for
  "idType":         string,    // required; Entity type (matches Assignment Store key)
  "evaluationContext": {       // optional; additional attributes for Condition matching
    [attribute: string]: string | number | boolean
  }
}
```

No `runId` parameter. Always evaluates against the current live Run. If no Run is live,
behaves as if Flag is disabled.

## Response shape

```
{
  "variant": string,           // resolved Variant name
  "reason":  ReasonDetail,     // why this Variant was chosen (discriminated union)
  "liveRunId": string | null   // the Run evaluated against; null if no live Run
}
```

## Reason discriminated union

```
type ReasonDetail =
  | {
      type: 'rule_matched'
      ruleId:   string    // stable rule identity
      ruleName: string    // human-readable label
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

~60s KV propagation window applies: immediately after a Publish, the endpoint may briefly
resolve against the old config. This is acknowledged and consistent with data-plane behavior
(ADR-0009). The endpoint documents this in its response: `liveRunId` reflects what was
actually evaluated.

## Error contract

| Condition | HTTP status | Detail |
|---|---|---|
| Flag not found for appId | 404 | `{ error: 'FLAG_NOT_FOUND' }` |
| No live Run (Experiment is draft) | 200 | `variant = defaultVariant`, `reason = { type: 'default_disabled' }`, `liveRunId = null` |
| Invalid flagKey / missing required field | 400 | Zod validation error shape |
| Auth failure | 401/403 | Control-plane token invalid or insufficient scope |

## Seam boundary

**What's on this side (test-evaluation endpoint):** evaluate for debug/verify purposes;
return `(variant, reason, liveRunId)`; write nothing.

**What's NOT here:** Exposure firing, Assignment Store writes, data returned to the
production SDK.

**Deletion test:** this is a single-implementation boundary deliberately. No swap needed —
the test-evaluation endpoint is the one control-plane endpoint for dry-run evaluation.
The exposure-free guarantee is its entire reason for existence.

**No superposition:** the caller always gets `(variant, reason)`. There is no state where
"maybe an Exposure fired." The endpoint does not take a mode parameter.

## Sources

- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
