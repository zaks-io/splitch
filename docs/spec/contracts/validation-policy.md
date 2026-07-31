# Validation policy: where Zod runs, what each layer trusts

Validation is a security and correctness boundary. Decisions about which layer validates and which
trusts are not optional. Each rule here is non-negotiable; the reasoning is in the sources.

---

## Layer matrix

| Layer                              | What it receives                                | Zod parse?          | Failure action                                                                                                 |
| ---------------------------------- | ----------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| Worker HTTP edge                   | Every request (body, path params, query params) | **Always**          | `ErrorResponse { code: 'VALIDATION_ERROR', details: { issues } }` — no partial accepts                         |
| KV reads (all, including hot path) | JSON blobs                                      | **Always**          | `ErrorResponse { code: 'INTERNAL_SERVER_ERROR' }` + loud log — blob is corrupted cache, not user error         |
| D1 reads                           | Drizzle ORM rows                                | **Never** (trusted) | — column schema enforced by Drizzle migrations; structurally sound by construction                             |
| Tinybird reads                     | Raw event rows                                  | **Never**           | Query-time filtering is on values; append-only log corruption is a platform incident, not app-boundary concern |
| Assignment Store KV                | `AssignmentStoreValue` blobs                    | **Always**          | `INTERNAL_SERVER_ERROR` + loud log — present-but-corrupt blob is never treated as a miss                       |

---

## Rule 1: Worker boundary — every untrusted input is Zod-parsed

"Untrusted" means anything crossing the HTTP boundary from outside the Worker:

- Request body (JSON)
- Path parameters (strings)
- Query parameters (strings, coerced to typed values)

No exceptions for "high-traffic" endpoints. The hot-path data-plane evaluate endpoint is Zod-parsed.
(ADR-0025: "contract edge always".)

Parse failure returns HTTP 400 with `ErrorResponse` shape:

```
{ code: 'VALIDATION_ERROR', message: '...', details: { issues: [{path, message}] } }
```

No partial accepts. Zod `.strict()` on all `PatchRunRequest`-style bodies that explicitly reject keys.

---

## Rule 2: KV reads — every blob is Zod-parsed

KV is schemaless JSON with real version skew. A blob written by old code may not match the current
schema. Every KV read — including the latency-critical Assignment Store `getAll()` and flag config
reads — is Zod-parsed before the value is used.

Failure contract:

- Malformed blob → `INTERNAL_SERVER_ERROR` response + structured log entry (blob key, parse errors).
- **No silent swallowing.** Fail loud, not fail-open.
- The hot path trades latency for loudness. Optimize only with a measured reason. (ADR-0025.)

Assignment Store miss (key not found, not corrupt) is NOT an error — it means a new Entity, and
`assign()` runs. Only a present-but-malformed blob is an error.

---

## Rule 3: D1 reads — structurally trusted

D1 rows are written only through Drizzle migrations and the Worker's data-access layer. They are not
Zod-re-parsed on read. Structural correctness is enforced by the migration system, not runtime checks.

This trust is bounded: the Worker's data-access layer is the **only** write path into D1. No direct
SQL access, no external migration tools that bypass Drizzle.

---

## Rule 4: Tinybird reads — unvalidated

Raw Exposure/Activation rows are append-only. The Tinybird schema enforces column types at ingest;
corruption is a platform incident, not an application-boundary concern. Query-time filtering is on
values (e.g. `WHERE app_id = ?`), not schema validation.

---

## Invariants enforced in the Worker (not in tools, not in CLI)

All domain invariants live in the Worker — both skins (MCP, CLI) inherit correctness for free (ADR-0023).

| Invariant                             | Enforcement                                                                                                                                                                   | Error code                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Run frozen fields**                 | Reject `PatchRunRequest` with any of `{salt, allocation, variantSet, targetingRules, targetingSegmentId}`                                                                     | `RUN_FROZEN`                                 |
| **Variant frozen per Run**            | Reject `PatchVariantRequest.value` if any running Run's `variantSet` includes this variant                                                                                    | `RUN_FROZEN`                                 |
| **Allocation sums to 100**            | Sum check on the staged Experiment draft allocation when Start freezes it into a Run                                                                                          | `ALLOCATION_INVALID`                         |
| **Activation ordering**               | Analysis filters candidates by `activation_ts > first_exposure_ts`, then selects the earliest valid Activation; pre-Exposure rows remain replay truth but never count         | none                                         |
| **app_id scoping**                    | Every D1/Tinybird query filtered by `app_id` (and `environment_id` co-scoped for experiments/runs/exposures/credentials, ADR-0027) in the data-access layer                   | `FORBIDDEN` (wrong app)                      |
| **Credential scopes**                 | KV cache lookup on every request; checked before the handler runs                                                                                                             | `INSUFFICIENT_SCOPES` / `CREDENTIAL_REVOKED` |
| **targetingKey assignment edit**      | Reject `PatchExperimentRequest.targetingKey` or `targetingKeyType` when Experiment.status = `'running'`                                                                       | `RUN_FROZEN`                                 |
| **Activation Metric assignment edit** | Reject `PatchExperimentRequest.activationMetricId` when Experiment.status = `'running'`                                                                                       | `RUN_FROZEN`                                 |
| **Decision family lock**              | Reject changing `confidenceLevel`, horizon/tuning fields, goal Metric roles, Guardrail thresholds/directions, or Primary Dimensions for a running Run's decision-valid result | `DECISION_LOCKED`                            |
| **Metric denominator same App**       | Check `denominator.metricId` belongs to same `appId` on create                                                                                                                | `VALIDATION_ERROR`                           |

---

## Test-evaluation endpoint: structurally write-free

The test-evaluation endpoint (`POST /apps/:appId/envs/:environmentId/flags/:flagId/test-eval`) runs the full Provider
resolution + rule-matching, may read Assignment Store holdover state, but is wired to **no write
path**. There is no code path from it to:

- The Exposure log (Tinybird append)
- The Assignment Store `put()` path (KV / DO write)

This is a structural property of the endpoint, not a runtime flag. (ADR-0026.)

The endpoint validates its request with Zod (Rule 1), reads flag config from KV (Zod-parsed, Rule 2),
and returns `TestEvaluationResponse`. If the KV blob is corrupt, it returns `INTERNAL_SERVER_ERROR`,
not a partial resolution.

---

## Start action: atomicity contract

When `POST /apps/{app_id}/envs/{environment_id}/experiments/:id/start` fires:

1. Worker validates the lifecycle request body (Zod): optional
   `review: { action: 'approve_and_apply' }`, optional `reason`, and required `idempotency_key` only.
   Assignment config is rejected here and must already be staged on the Experiment draft via
   create/patch. The CLI `--confirm` affordance derives the inline canonical Review; there is no
   stateless confirmation-retry body.
2. Worker validates the staged draft assignment config: allocation sums to 100, Variants are
   available in this Environment, and draft Segment ids resolve to frozen `targetingRules`.
3. Under `allow`, enter the canonical application transaction directly. Under `confirm` or future
   `approve`, persist/resolve the Approval Request, authorize Review, and validate the target
   version first. The D1 transaction then ends any running Run (set `ended_at`,
   `status = 'ended'`), inserts the new Run, updates `experiments.live_run_id`, consumes the draft
   assignment fields, and atomically records the successful Review and Approval Request transition.
4. KV sync: write the D1-derived reader set: `app:{appId}:{environmentId}:experiment:{experimentId}`
   with `ExperimentConfigKV.liveRunId`, `app:{appId}:{environmentId}:run:{newRunId}` with
   `RunConfigKV`, and `live_run:{appId}:{environmentId}:{experimentId}` with `LiveRunKV`.
5. Broadcast WebSocket nudge (ADR-0019) after D1 + KV succeed.

When `POST /apps/{app_id}/envs/{environment_id}/runs/{run_id}/end` fires, the same D1-derived KV
sync rewrites `ExperimentConfigKV.liveRunId` to `null` and deletes
`live_run:{appId}:{environmentId}:{experimentId}`. Evaluation and ingest readers use
`ExperimentConfigKV.liveRunId` plus `RunConfigKV`; they never infer a live Run from the latest D1
Run.

If D1 succeeds but KV write fails: D1 is truth and the config-store sync is replayable from D1. Nudge
is NOT sent until KV is confirmed. This preserves the ADR-0019 persisted-before-announced ordering.
Edge readers remain fail-loud on missing or mismatched live Run config rather than deriving state
from D1 history.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0002-run-is-the-immutable-unit-of-analysis.md](../../adr/0002-run-is-the-immutable-unit-of-analysis.md)
- [../../adr/0003-material-edits-including-measurement-open-a-new-run.md](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
