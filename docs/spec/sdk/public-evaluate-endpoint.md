# Public evaluate endpoint: `POST /evaluate`

The single data-plane endpoint the client-side SDK calls. Safe under a public Client Key:
returns only the resolved Variant — never config, rules, allocation, or salt (ADR-0018).

## Endpoint

```
POST /apps/:appId/evaluate
Authorization: Bearer <clientKey>
Content-Type: application/json
```

## Request shape

```
EvaluateRequest {
  flagKey:           string        -- required; Flag Key unique within the App
  targetingKey:      string        -- required; the Entity identifier (CONTEXT.md: Targeting Key)
  idType:            string        -- required; the Entity type label (e.g. 'user', 'workspace')
                                   -- carried through to Exposure row and Assignment Store key
  evaluationContext: {             -- required object; attributes for Targeting Rule evaluation
    targetingKey: string           -- must equal top-level targetingKey (redundant but required
                                   -- for OpenFeature context shape compatibility)
    [key: string]: unknown         -- arbitrary attributes; available to Targeting Rule Conditions
  }
}
```

`idType` is a first-class required field (not derived from context) so the Assignment Store
key `(experiment, idType, targetingKey)` is unambiguous (ADR-0007).

The **Environment is resolved from the Client Key**, not a request field: a Client Key is per
`(app_id, environment_id)` (ADR-0027), and the edge reads `environment_id` from the key's validation
cache value to select which Environment's Flag Configuration and live Experiment Runs to serve.

## Response shape

```
EvaluateResponse {
  variant: VariantValue    -- the resolved Variant value for this Entity (see Variant type below)
}
```

### Variant value type

```
VariantValue = boolean | string | number | JsonObject

JsonObject = { [key: string]: VariantValue }   -- recursive; matches Flagship Variation shape
```

`assign()` returns the Variant **name** (string); the endpoint resolves the Variant's value
from the Flag definition and returns that value. The Exposure log records the Variant name,
not the value (the value can change; the name is the immutable experimental arm identifier).

## What the response NEVER includes (ADR-0018)

- Targeting Rules or Targeting Rule conditions
- Percentage Rollout allocation fractions
- The salt used for Fractional Evaluation
- Other Entities' Variants or assignments
- The full Flag config / Variant set
- Resolution reason or which rule matched (that is the test-evaluation endpoint — different auth)
- Debug metadata

Exposing any of these under a public Client Key would allow reverse-engineering the experiment
design. This is a hard endpoint-design constraint, not a later policy bolt-on.

## Exposure side effect

Calling this endpoint (via the `evaluate` SDK accessor) fires an Exposure as a side effect.
The Exposure is appended to the raw log by the Worker, never by the client.
See [exposure-accessor.md](./exposure-accessor.md) for the full accessor contract.

The `peekVariant` accessor calls a **peek variant** of this same endpoint that does NOT fire
the Exposure. The endpoint distinguishes them by the SDK call path, not a caller-supplied flag.
(Peek uses a separate endpoint or request field — see [exposure-accessor.md](./exposure-accessor.md).)

## Init and lazy-fetch

- SDK instantiation succeeds immediately; no flag config is fetched at init time.
- The first `evaluate(flagKey)` call fetches from the endpoint and caches the resolved Variant
  in memory for subsequent calls within the session/instance.
- If the endpoint is unreachable and no cached value exists, the SDK returns the
  **Default Variant** (CONTEXT.md) without firing an Exposure.
- Single-flag-per-call in v1. Batch evaluation (`evaluateAll`) is a future
  extension; no `/evaluate-batch` endpoint is built in v1.

## Edge binding

Client Key requests pass through Cloudflare WAF before reaching the Worker (ADR-0018):
- Origin/referrer allow-list enforcement (per-key, WAF-level)
- Per-key rate limiting (WAF-level)

WAF rejection returns a 403/429 before the Worker is invoked. The SDK client must handle
these as non-retryable (403) or back-off (429) errors.

## Error responses (ADR-0025 shape)

All errors use the shared `ErrorResponse` shape:
```
ErrorResponse {
  code:     string        -- machine-readable enum value
  message:  string        -- human-readable
  details?: unknown       -- optional structured data per error code
}
```

| HTTP status | `code` | Meaning |
|------------|--------|---------|
| 401 | `INVALID_CREDENTIAL` | Missing, invalid, or revoked Client Key |
| 403 | `APP_MISMATCH` | Client Key does not belong to the requested appId |
| 404 | `FLAG_NOT_FOUND` | flagKey does not exist in this App |
| 422 | `VALIDATION_ERROR` | Request body failed Zod parse; `details` has field errors |
| 429 | `RATE_LIMITED` | Per-key rate limit exceeded (may be WAF-level) |
| 503 | `PROVIDER_UNAVAILABLE` | Flag config could not be resolved; SDK should return Default Variant |

On 503 the SDK returns Default Variant and does NOT fire an Exposure. On 404 the SDK
returns Default Variant and does NOT fire an Exposure (the Flag may not exist yet).

## Seam contract

- **Port:** `evaluate(appId, clientKey, flagKey, targetingKey, idType, evaluationContext) -> VariantValue`
- **Left side:** SDK HTTP client (presents Client Key in Authorization header)
- **Right side:** Worker that validates credential, loads Provider config + Assignment Store
  holdover, calls `assign()`, fires Exposure, returns Variant value
- **Failure contract:** credential invalid → 401; flag missing → 404 + Default Variant;
  Provider unreachable → 503 + Default Variant; no distributed transaction (ADR-0006)
- **Idempotency:** read-only except for the Exposure side effect; retrying a failed call may
  produce a duplicate raw Exposure row, which is correct (at-least-once, pipeline deduplicates)

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
