# Request/response envelopes: conventions and evaluate endpoints

Shared envelope conventions (create/patch asymmetry, pagination) plus the dry-run test-evaluation and
public data-plane evaluate contracts.

Envelopes compose leaf schemas from the leaf-schemas files. They are **distinct** — never fused —
because create and patch have different required fields, and storage shapes carry internals (version,
audit) that must not leak to the wire. (ADR-0025 "reuse at the leaf".)

All envelopes are Zod schemas in `@splitch/contracts`. No field documented across the envelope files is
inferred or optional unless explicitly marked `no`.

## Wire conventions (all control-plane endpoints)

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

## Pagination wrapper (reused by all list endpoints)

```
PaginatedResponse<T> = {
  items:      T[]
  cursor:     string | null  // opaque; pass back as ?cursor= to fetch next page; null on the last page
  limit:      number         // the limit that was applied
  total:      number | null  // see "total semantics" below
}
```

Pagination is **cursor-based, not offset-based**, on every list endpoint. Request a page with
`?limit=<n>&cursor=<opaque>`; `limit` defaults to `50` and is capped at `500` (over-cap →
`INVALID_PAGINATION { field: 'limit' }`). To iterate, keep calling with the returned `cursor` until
`cursor === null`.

**Cursor contract.** The `cursor` is an opaque, server-encoded string. Do not parse, construct, or
mutate it. A cursor is valid for **15 minutes** and is scoped to the exact `(endpoint, filters, limit)`
it was issued for — reusing it across a different filter set or after expiry returns
`INVALID_PAGINATION { field: 'cursor', reason: 'cursor_expired' | 'cursor_invalid' }`. Never reuse a
cursor across Environments.

**`total` semantics.** Whether `total` is a number or `null` is determined by the backing store, and
is stable per endpoint:

- **D1-backed lists** (Flags, Experiments, Runs, Metrics, Segments, Members, credentials) always
  return `total` as a number — the count is cheap.
- **Tinybird-backed lists** (Exposures, analytics) return `total: null` — counting can be
  100M+ rows. Consumers render "showing X (more available)", never "page N of M", when `total` is
  `null`.

Where a list is **projected after the store returns it** — a status the store does not persist and
the API computes on read, such as an Approval Request rendering `stale` — `total` counts the rows
the store matched, so a filter on a projected field narrows `items` without narrowing `total`. That
is the one case where `items.length` and `total` disagree for reasons other than paging. Agents must
still loop on `cursor`; a projection-filtered list can legitimately return an empty page with a
non-null `cursor` and a non-zero `total`.

**Agent iteration.** Loop on `cursor` (`while (cursor !== null)`), not on `total`. `total` is for UI
display and may be `null`; the `cursor` is the authoritative end-of-list signal on every endpoint.

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
