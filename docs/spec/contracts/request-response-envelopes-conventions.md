# Request/response envelopes: conventions and evaluate endpoints

Shared envelope conventions (create/patch asymmetry, pagination) plus the dry-run test-evaluation and
public data-plane evaluate contracts.

Envelopes compose leaf schemas from the leaf-schemas files. They are **distinct** — never fused —
because create and patch have different required fields, and storage shapes carry internals (version,
audit) that must not leak to the wire. (ADR-0025 "reuse at the leaf".)

All envelopes are Zod schemas in `@splitch/contracts`. No field documented across the envelope files is
inferred or optional unless explicitly marked `no`.

## Wire conventions (all control-plane endpoints)

**Unknown request keys fail loud.** External create and patch bodies use Zod `.strict()`, including
nested write objects (`WriteCondition`, `WriteMetricRef`, `TargetingRuleInput`, `runs_end`). An
unrecognized field is `VALIDATION_ERROR` with the field path (for example
`["body", "metrics", "0", "extra"]`). Response and storage schemas stay permissive so retained
KV/D1 rows remain readable.

**Persisted field bounds.** Write envelopes compose named limits from `persisted-field-limits.ts`
(names 200, descriptions 2000, identifiers 128, Condition values 1024, Variant strings 4096, salts
128, arrays 100 items, records 64 keys, JSON depth 8, Client Key origins 2048, telemetry enums 256,
Idempotency Keys 255 printable ASCII without whitespace). Over-limit values fail at parse. Stored
values are not truncated.

**Optional fields are present-with-null, never omitted.** A field marked optional (`no`) in any
envelope or leaf schema appears in the JSON with a `null` value rather than being absent. Consumers
never need `hasOwnProperty` checks; the field always exists, the value may be `null`. The only
exception is a field explicitly documented as "omitted when X" in its own schema.

**Standard response headers.** Every JSON response carries:

| Header         | When          | Meaning                                                                                             |
| -------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `X-Request-Id` | always        | Stable per-request id; echoed in server logs and `INTERNAL_SERVER_ERROR`. Quote it in support.      |
| `Retry-After`  | `429` / `503` | Seconds to wait; mirrors `details.retryAfterMs` in the `RATE_LIMITED` / `SERVICE_UNAVAILABLE` body. |
| `Content-Type` | always        | `application/json; charset=utf-8`.                                                                  |

Clients and agents read `Retry-After` for backoff and surface `X-Request-Id` on failures so a human
can find the request in logs.

**Timestamps.** All timestamps are ISO 8601, UTC, millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`),
server-normalized. Clients never supply a timezone.

**API versioning.** The control-plane API is **unversioned** (one canonical version per release;
ADR-0025 makes the Zod contract the single source). Breaking changes ship behind a minor release with
a CHANGELOG entry; a soon-to-change endpoint carries a `Deprecation` response header (RFC 8594) for at
least 90 days before the change. Long-lived clients must tolerate **unknown** `ErrorCode` and
`reason` enum values (log and treat as the nearest known category) rather than hard-failing on a new
member.

Resource envelope files:

- [request-response-envelopes-flag-variant.md](./request-response-envelopes-flag-variant.md) — Flag and Variant endpoints
- [request-response-envelopes-experiment-run.md](./request-response-envelopes-experiment-run.md) — Experiment and Run endpoints
- [request-response-envelopes-org-app-credentials.md](./request-response-envelopes-org-app-credentials.md) — Metric, App, Org, and Credential endpoints

---

## ListResponse wrapper (every `*_list` operation)

```text
ListResponse<T> = {
  items:         T[]
  readLimit:     positive integer  // cap actually applied to this read
  readTruncated: boolean           // observed at limit+1, never inferred
  cursor:        string | null     // null = no continuation available from this call
}
```

Completeness and continuation are two fields and must not collapse. Pagination is completable: loop
until `cursor === null`. `readTruncated` is not: there is no next page, the call is reporting that
the answer is incomplete and the query must be narrowed. A bounded-but-unpaginable list has
`cursor: null` forever and can still be truncated.

`cursor: null` means "no continuation available from this call". Completeness is read from
`readTruncated` alone. `cursor: null` with `readTruncated: true` is the honest encoding of "there is
more and this call cannot get it for you".

Every list array is under `items`. There is no `total` on a list response — an always-null count is
the disguised shape ADR-0036 forbids. A real count, if wanted, is a `*_count` operation.

The applied cap is `LIST_READ_LIMIT` (200). Requested `limit` may differ. The two caps are
distinct: the request schema maximum is 500; the applied read never exceeds 200. A caller asking
`limit=500` (the request maximum) against the 200-cap sees `readLimit: 200`. Request `limit` stays
a query param on paginated routes (`approval_requests_list`: default 50, schema-max 500;
`limit > 500` → `INVALID_PAGINATION { field: 'limit' }`). Other `*_list` routes are unpaginable:
they always return `cursor: null` and report truncation when the scan hits the cap.

**Cursor contract (paginated lists).** The `cursor` is an opaque, server-encoded string. Do not
parse, construct, or mutate it. A cursor is valid for **15 minutes** and is scoped to the exact
`(endpoint, filters, applied readLimit)` it was issued for — reusing it across a different filter
set or after expiry returns
`INVALID_PAGINATION { field: 'cursor', reason: 'cursor_expired' | 'cursor_invalid' }`. Never reuse a
cursor across Environments.

**Agent iteration.** On a paginated list, loop on `cursor` (`while (cursor !== null)`). Then read
`readTruncated`. On an unpaginable list, `cursor` is always null; if `readTruncated` is true, narrow
the query rather than asking for a next page.

---

## Test-evaluation endpoint (dry-run, control-plane token)

See also [mcp-tool-derivation.md](./mcp-tool-derivation.md) for the tool contract.

Route: `POST /apps/:appId/envs/:environmentId/flags/:flagKey/test-eval`
MCP tool: `flags_test_eval`

### TestEvaluationRequest

| Field               | Required | Notes                                                                |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `evaluationContext` | yes      | `EvaluationContext` leaf: `targetingKey`, `idType`, and `attributes` |

The Flag is identified by `flagKey` in the path. `EvaluationContext.targetingKey` is the Entity
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
  | { type: 'fresh_assignment' } // empty Run targetingRules; assign(Run, Targeting Key) served
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
  variant:     VariantValue | null  // null if Flag not found or disabled and no Default Variant
  variantName: string | null        // the resolved arm's label; null when no arm resolved
}
```

`variantName` is the immutable arm label and is public-safe on every credential tier (the verify
endpoint already returns it under a Client Key). It rides the wire because the SDK cannot derive it
— two arms may carry the same value — and `ResolutionDetails.variantName` is part of the documented
return shape.

No `reason`. No rule set. No `salt`. No config. Safe under public Client Key (ADR-0018): the response
names WHICH arm was served, never HOW it was chosen.
Peek uses a separate SDK path/endpoint with the same response shape and no Exposure side effect,
never a caller-supplied `deferExposure` flag.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md)
- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)
