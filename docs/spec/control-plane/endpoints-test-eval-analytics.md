# Control-plane-authorized endpoints: test-evaluation, analytics proxy, schema discovery

Request/response shapes for the dry-run test-evaluation endpoint, the Tinybird analytics proxy reads,
and the unauthenticated OpenAPI schema discovery endpoint.

These endpoints share control-plane auth and contracts, but they do not all live on one Worker.
Dry-run test-evaluation is mounted on the **Evaluation Worker**. Analytics proxy reads are mounted
on the **Analysis Worker**. OpenAPI schema discovery is served by the **Control Plane API Worker**.
All require a control-plane bearer token unless noted. All requests/responses are
`Content-Type: application/json`. Error shape, pagination, and the shared conventions are described
in [control-plane-endpoint-inventory.md](control-plane-endpoint-inventory.md).

**Per-Environment (ADR-0027).** Test-eval, results, and the audit log are scoped to one Environment,
so they live under `/apps/{app_id}/envs/{environment_id}/…`. A dry-run resolves against _that_
Environment's Flag Configuration; results read _that_ Environment's Exposures.

## Test-evaluation endpoint (dry-run)

### `POST /apps/{app_id}/envs/{environment_id}/flags/{flag_id}/test-eval`

Resolves the Flag **in this Environment** for a given Evaluation Context without firing an Exposure or
writing the Assignment Store. It may read holdover state to report `holdover_replay`. Lives behind the
control-plane token (never Client/API Key). Returns the resolution reason, which the public evaluate
endpoint must never reveal.

**Request body:**

```
{
  evaluationContext: {
    targetingKey: string,
    idType: string,
    attributes: Record<string, boolean | string | number | unknown[]>
  }
}
```

**Response:**

```
{
  variantName: string,
  value: VariantValue,
  liveRunId: string | null,
  reason:
    | {
        type: "holdover_replay",
        priorRunId: string
      }
    | {
        type: "rule_matched",
        ruleId: string,
        ruleName: string | null,
        priority: number,
        selection: "direct" | "percentage_rollout",
        rollout?: { variantWeights: { variantName: string, weight: number }[] }
      }
    | { type: "default_disabled" }
    | { type: "no_match_default" }
}
```

The canonical request and response envelopes live in
[../contracts/request-response-envelopes-conventions.md](../contracts/request-response-envelopes-conventions.md).
Reason shape is a Zod discriminated union on `type`. `rule_matched` carries enough info for a human
or agent to identify which Targeting Rule fired. Percentage Rollout outcome is implied by the
`selection` field; the bucket and salt are not exposed in the response. `holdover_replay` names the
prior Run that owns the sticky experience.

**Invariant:** wired to no write path — no Exposure log row, no Assignment Store `put()`, by
construction (ADR-0026).

## Analytics proxy endpoints

Tinybird is never queried directly by clients or agents. The Analysis Worker proxies analytics
reads, injecting `app_id` and `environment_id` from the auth/path context (mandatory, non-defaulted).

### `GET /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/results`

Returns experiment analysis summary for the live Run (or specified `?run_id=`), over this
Environment's Exposures.
Response shape: defined in stats area spec; cross-link here when available.

### `GET /apps/{app_id}/audit-log`

Returns `?limit=50&offset=0` paginated audit events for the App. App-level (spans Environments); each
event carries its `environment_id` (null for App-level definition changes). Filter with
`?environment_id=`.

## Schema discovery

### `GET /.well-known/openapi.json`

Unauthenticated. Returns the OpenAPI 3.1 document generated from Zod schemas at build time.
Agents can fetch this at handshake time to discover all tool schemas.

## Sources

- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
