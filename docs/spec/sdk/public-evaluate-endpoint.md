# Public evaluate endpoint: `POST /api/sdk/evaluate`

The single data-plane endpoint the client-side SDK calls. Safe under a public Client Key:
returns the resolved Variant and a **non-revealing** `reason` (OpenFeature `ResolutionDetails`,
ADR-0036) — never config, rules, allocation, salt, or which rule matched (ADR-0018).

## Endpoint

```
POST /api/sdk/evaluate
Authorization: Bearer <clientKey>
Content-Type: application/json
```

## Request shape

```
EvaluateRequest {
  flagKey:           string        -- required; Flag Key unique within the App
  targetingKey:      string        -- required; the Entity identifier (CONTEXT.md: Targeting Key)
  idType:            string        -- required on the wire; the Entity type label (e.g. 'user',
                                   -- 'workspace'); carried through to Exposure row and
                                   -- Assignment Store key. SDK defaults it to 'user' (see below).
  evaluationContext: {             -- required object; attributes for Targeting Rule evaluation
    targetingKey: string           -- must equal top-level targetingKey (redundant but required
                                   -- for OpenFeature context shape compatibility)
    [key: string]: unknown         -- arbitrary attributes; available to Targeting Rule Conditions
  }
}
```

`idType` is a first-class required field **on the wire** (not derived from context) so the
Assignment Store key `(experiment, idType, targetingKey)` is unambiguous (ADR-0007). The
**SDK defaults `idType` to `'user'`** when the caller omits it — the common case buckets on
users — and it is overridable per call (`evaluate(flagKey, { targetingKey, idType })`). The
default is applied client-side before the request is sent; the wire contract still requires
the field. This removes the most common DX paper cut (a hello-world evaluate is `flagKey` +
`targetingKey`) without weakening the server's disambiguation guarantee.

The **Environment is resolved from the Client Key**, not a request field: a Client Key is per
`(app_id, environment_id)` (ADR-0027), and the edge reads `environment_id` from the key's validation
cache value to select which Environment's Flag Configuration and live Experiment Runs to serve.

**`app_id` authority — credential is the sole source.** The route carries no `:appId` path
parameter (`/api/sdk/evaluate`, not `/apps/:appId/evaluate`): the only `app_id` that reaches
Provider reads, Assignment Store keys, or the Exposure row is the one bound to the validated
credential (ADR-0018). A client may include an optional `appId` in the request body as an
**assertion**; if present it is compared against the credential's `app_id` and the request is
rejected `403 APP_MISMATCH` on mismatch, then discarded on match — it is never a data scope, a
fallback, or a default. There is no code path where a client-supplied `app_id` selects tenant
data. Keeping `app_id` out of the path removes the tenant-crossing footgun at the route level
rather than relying on a guard to neutralize a path param.

## Response shape

The response carries the OpenFeature [`ResolutionDetails`](https://openfeature.dev/specification/types/)
shape (ADR-0036) — never a bare value. Every result is observable and self-explaining; a
fallback caused by failure is never disguised as a real resolution.

```
EvaluateResponse {
  variant:      VariantValue   -- the resolved Variant value for this Entity (see Variant type below)
  variantName:  string         -- the Variant name (immutable arm label; public-safe)
  reason:       Reason         -- why this value (NON-REVEALING set under a Client Key, see below)
  errorCode?:   ErrorCode      -- present only when reason = ERROR (OpenFeature enum)
  errorMessage?: string        -- present only when reason = ERROR
}
```

`evaluate` (value accessor) unwraps this to `variant`; `evaluateDetails` returns the whole
shape. See [exposure-accessor.md](./exposure-accessor.md).

### Reason under a public Client Key (ADR-0018, ADR-0036)

A Client Key sees only the **non-revealing** reason set — it never learns _which_ Targeting
Rule matched, the allocation fraction, or the salt:

```
Reason = 'SPLIT' | 'DEFAULT' | 'DISABLED' | 'CACHED' | 'STALE' | 'ERROR'
```

`TARGETING_MATCH` (which names rule-driven resolution) and the rule identity are reserved for
the API-Key and control-plane tiers (peek, test-eval — ADR-0026, ADR-0037). A rule-driven
result under a Client Key reports `SPLIT` or `TARGETING_MATCH` **without** naming the rule.

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

The `peekVariant` accessor calls a **separate** peek endpoint that does NOT fire the Exposure.
Peek is a **server-side (API Key) path, not this public Client Key path** (ADR-0034): a silent,
SRM-invisible read under a public key is an allocation oracle. This public endpoint is
`evaluate`-only and always Exposure-bearing — see [exposure-accessor.md](./exposure-accessor.md).

## Init and lazy-fetch

- SDK instantiation succeeds immediately; no flag config is fetched at init time.
- The first `evaluate(flagKey)` call fetches from the endpoint and caches the resolved Variant
  in memory for subsequent calls within the session/instance (`reason: CACHED` on hits).
- If the endpoint is unreachable and no cached value exists, the SDK returns the **Default
  Variant** (CONTEXT.md) with `reason: ERROR` + an `errorCode`, fires **no** Exposure, and
  emits a loud error log / error hook (ADR-0036). **This is never silent** — the caller can
  always tell a failure-fallback from a real resolution via `reason`. A degraded-to-default
  result keeps the customer's app running; a _hidden_ one is forbidden.
- Single-flag-per-call. Batch evaluation (`evaluateAll`) is deferred; no `/evaluate-batch` endpoint
  is defined.

## Edge binding

Client Key requests pass through Cloudflare WAF before reaching the Worker (ADR-0018, ADR-0034):

- Origin/referrer allow-list enforcement (per-key, WAF-level). New Client Keys are **origin-closed
  by default** — allow-all is an explicit, loud choice, never the silent default
  (see [credentials-and-keys.md](../control-plane/credentials-and-keys.md)).
- Per-key rate limiting (WAF-level), counter keyed on the Client Key value
- Progressive rules (challenge before block) layered over the per-key counter

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

| HTTP status | `code`                | Meaning                                                                         |
| ----------- | --------------------- | ------------------------------------------------------------------------------- |
| 401         | `UNAUTHORIZED`        | Missing or invalid Client Key                                                   |
| 403         | `CREDENTIAL_REVOKED`  | Client Key is revoked                                                           |
| 403         | `APP_MISMATCH`        | Client Key does not belong to the requested appId                               |
| 404         | `FLAG_NOT_FOUND`      | flagKey does not exist in this App                                              |
| 400         | `VALIDATION_ERROR`    | Request body failed Zod parse; `details` has field errors                       |
| 429         | `RATE_LIMITED`        | Per-key rate limit exceeded (may be WAF-level)                                  |
| 503         | `SERVICE_UNAVAILABLE` | Flag config could not be resolved; SDK returns Default Variant, `reason: ERROR` |

**Failure (loud) vs. legitimate default (normal), per ADR-0036:**

- **503 `SERVICE_UNAVAILABLE`** and network/parse errors are _failures_: the SDK returns the
  Default Variant with `reason: ERROR` + `errorCode: PROVIDER_NOT_READY`, fires no Exposure, and
  logs loudly. Not silent. The 503 carries a `Retry-After` header; the SDK does not auto-retry the
  Exposure-bearing call (a retry would be a fresh resolution, not a replay).
- **404 `FLAG_NOT_FOUND`** is a _failure_ too (a flagKey that does not exist is a setup bug,
  not a normal value): `reason: ERROR`, `errorCode: FLAG_NOT_FOUND`, no Exposure, loud.
- A flag that **exists but is disabled** or **has no Configuration in this Environment**, or
  whose targeting produced **no match**, is a legitimate resolution: the SDK returns the
  Default Variant with `reason: DISABLED` / `DEFAULT` (not `ERROR`) and the dev still learns
  why. These are normal, not alarmist.

`errorCode` uses the OpenFeature standard enum (`PROVIDER_NOT_READY`, `FLAG_NOT_FOUND`,
`PARSE_ERROR`, `TYPE_MISMATCH`, `TARGETING_KEY_MISSING`, `INVALID_CONTEXT`, `PROVIDER_FATAL`,
`GENERAL`), mapped from the HTTP `ErrorResponse.code` at the SDK boundary.

### HTTP status to ResolutionDetails mapping

This is the contract that makes fail-loud **usable**: the SDK turns every transport outcome into a
structured [`ResolutionDetails`](../contracts/leaf-schemas-runtime.md#resolutiondetails-openfeature-sdk-return-shape)
the caller can branch on. The caller never has to inspect HTTP status itself.

| Transport outcome                     | `reason`   | `value`           | `errorCode`          | Exposure |
| ------------------------------------- | ---------- | ----------------- | -------------------- | -------- |
| `200`, rule/rollout resolved          | `SPLIT`    | resolved Variant  | —                    | fires    |
| `200`, no rule matched                | `DEFAULT`  | Default Variant   | —                    | fires    |
| `200`, Flag disabled / no Env config  | `DISABLED` | Default Variant   | —                    | fires    |
| in-memory cache hit (same instance)   | `CACHED`   | cached Variant    | —                    | no       |
| served from stale cache after failure | `STALE`    | last-good Variant | `PROVIDER_NOT_READY` | no       |
| `401` / `403`                         | `ERROR`    | Default Variant   | `PROVIDER_FATAL`     | no       |
| `404 FLAG_NOT_FOUND`                  | `ERROR`    | Default Variant   | `FLAG_NOT_FOUND`     | no       |
| `400 VALIDATION_ERROR`                | `ERROR`    | Default Variant   | `INVALID_CONTEXT`    | no       |
| `429 RATE_LIMITED`                    | `ERROR`    | Default Variant   | `GENERAL`            | no       |
| `503` / network / timeout / parse     | `ERROR`    | Default Variant   | `PROVIDER_NOT_READY` | no       |

Every `ERROR` row returns the **Default Variant** so the caller's UI still renders, carries a
non-null `errorCode`, and logs loudly — never a silent default (ADR-0036). The recommended caller
branch is a single check on `details.reason === 'ERROR'`.

## SDK initialization defaults

So a hello-world is genuinely copy-paste, the SDK ships sane defaults; each is overridable at
construction:

| Setting     | Default                                                                                                                  | Notes                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `endpoint`  | `https://edge.splitch.dev` (the public Evaluation Worker, ADR-0038)                                                      | Override for self-hosted / preview Workers.                             |
| `timeoutMs` | `1000`                                                                                                                   | On timeout the SDK fails loud to the Default Variant (`reason: ERROR`). |
| `retries`   | `0` on the Exposure-bearing `evaluate` (a retry is a fresh resolution, not a replay); peek/verify may retry idempotently | Never silently retry an Exposure-firing call.                           |
| `idType`    | `'user'`                                                                                                                 | Overridable per call.                                                   |

```ts
import { createSplitchClient } from "@splitch/sdk";

// Minimal: only the Client Key is required.
const splitch = createSplitchClient({ clientKey: "ck_live_..." });

// Hello-world resolution (idType defaults to 'user'):
const variant = await splitch.evaluate("new-checkout", { targetingKey: userId });

// Branch with details (fail-loud is one check):
const d = await splitch.evaluateDetails("new-checkout", { targetingKey: userId });
if (d.reason === "ERROR") renderFallback(d.errorCode);
else render(d.value);
```

## Seam contract

- **Port:** `evaluate(appId, clientKey, flagKey, targetingKey, idType, evaluationContext) -> VariantValue`
- **Left side:** SDK HTTP client (presents Client Key in Authorization header)
- **Right side:** Worker that validates credential, loads Provider config + Assignment Store
  holdover, calls `assign()`, fires Exposure, returns Variant value
- **Failure contract (fail-loud, ADR-0036):** credential invalid → 401; flag missing → 404 +
  Default Variant with `reason: ERROR`; Provider unreachable → 503 + Default Variant with
  `reason: ERROR`. Every failure-fallback carries `reason: ERROR` + `errorCode` and is
  logged loudly — never a silent default. No distributed transaction (ADR-0006).
- **Idempotency:** read-only except for the Exposure side effect; retrying a failed call may
  produce a duplicate raw Exposure row, which is correct (at-least-once, pipeline deduplicates)

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — fail-loud, ResolutionDetails, idType default
- [ADR-0037](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — tiered verification
