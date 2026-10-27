# Public evaluate endpoint: `POST /api/sdk/evaluate`

The single-Flag Exposure-bearing data-plane endpoint. Accepts a Client Key or API Key and is safe
under a public Client Key. It returns the resolved Variant and a **non-revealing** `reason` (OpenFeature `ResolutionDetails`,
ADR-0036) — never config, rules, allocation, salt, or which rule matched (ADR-0018).

## Endpoint

```
POST /api/sdk/evaluate
Authorization: Bearer <clientKey | apiKey>
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
  attributes: Record<string, boolean | string | number | unknown[]>
                                   -- defaults to {}; Targeting Rule attributes
  appId?: string                   -- optional credential-scope assertion
}
```

`idType` is a first-class required field **on the wire** (not derived from context) so the
Assignment Store key `(experiment, idType, targetingKey)` is unambiguous (ADR-0007). The
**SDK defaults `idType` to `'user'`** when the caller omits it — the common case buckets on
users — and it is overridable per call (`evaluate(flagKey, { targetingKey, idType })`). The
default is applied client-side before the request is sent; the wire contract still requires
the field. This removes the most common DX paper cut (a hello-world evaluate is `flagKey` +
`targetingKey`) without weakening the server's disambiguation guarantee.

The **Environment is resolved from the credential**, not a request field: an SDK credential is per
`(app_id, environment_id)` (ADR-0027), and the edge reads `environment_id` from the key's validation
cache value to select which Environment's Flag Configuration and live Experiment Runs to serve.

The Exposure-bearing route requires an `Idempotency-Key` header. The SDK generates a UUID for each
call when its optional `idempotencyKey` is omitted. An application that retries an uncertain request
supplies one non-empty key and reuses it for every attempt of that logical Evaluation. The SDK does
not retry automatically. The server cannot infer retries; a new key is a new Evaluation for billing
purposes. The pipeline hashes this value with its authenticated Organization/App/Environment scope
and a UTC 24-hour replay window before storing it. A replay only deduplicates within that scope and
window; the raw value never reaches Tinybird.

For a successful fresh live-Run resolution, Event Ingest atomically seals that scoped Evaluation claim,
the resolved-result fingerprint, the retry-stable Exposure `event_id`, and the canonical `raw_events`
outbox payload. An exact retry returns the original logical result without creating another Exposure
payload. Reusing the key with different canonical Evaluation content fails loud. A failed seal commits
none of the claim, payload, or Assignment Store side effect.

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
  value:        VariantValue   -- the resolved value or caller default
  variantName:  string | null  -- the Variant name when resolved
  reason:       Reason         -- why this value (NON-REVEALING set under a Client Key, see below)
  errorCode?:   SplitchSdkErrorCode -- present on failure; wire or SDK-local code
  errorMessage?: string        -- present only when reason = ERROR
}
```

This is the **SDK-synthesized** return shape, not the HTTP wire body. The wire response is
`{ variant: VariantValue | null }` (see [contracts/request-response-envelopes-conventions.md](../contracts/request-response-envelopes-conventions.md));
`variantName` rides the percent-encoded `x-variant-name` header because it is not derivable
client-side (two Variants may share a value),
while the SDK synthesizes the rest of `ResolutionDetails` (`reason`, `errorCode`, …) from that wire
body, HTTP status, and non-revealing response metadata. The `x-reason` header carries the resolution
kind without changing the frozen body (see [contracts/leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md)). `Reason` is the
`ResolutionReason` enum from `contracts/leaf-schemas-runtime.md` — do not redefine it.

`evaluate` (value accessor) unwraps this to `value`; `evaluateDetails` returns the whole
shape. See [exposure-accessor.md](./exposure-accessor.md).

### Reason under a public Client Key (ADR-0018, ADR-0036)

A Client Key sees only the **non-revealing** reason set — it never learns _which_ Targeting
Rule matched, the allocation fraction, or the salt:

```
Reason = 'SPLIT' | 'DEFAULT' | 'DISABLED' | 'CACHED' | 'STALE' | 'ERROR'
```

`TARGETING_MATCH` (which names rule-driven resolution) and the rule identity are reserved for
API-Key `verify` and control-plane test-eval (ADR-0026, ADR-0037). This endpoint returns
`SPLIT` for rule-driven results under either credential tier, without naming the rule.

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
- Revealing resolution detail or which rule matched (that is the test-evaluation endpoint — different auth)
- Debug metadata

Exposing any of these under a public Client Key would allow reverse-engineering the experiment
design. This is a hard endpoint-design constraint, not a later policy bolt-on.

## Exposure side effect

Calling this endpoint (via the `evaluate` SDK accessor) for a successful live Experiment Run
resolution fires an Exposure as a side effect. Before returning `200`, the Evaluation Worker waits
for the retry-stable Exposure and payload to be sealed in the Event Ingest `raw_events` outbox,
then awaits the Assignment Store first-touch write and KV write-through. A holdover-write failure
returns `503 SERVICE_UNAVAILABLE` after the Exposure has committed; the caller must reuse its
idempotency key for a retry. Queue publication and Tinybird remain asynchronous. Outbox-seal
failure returns a fail-loud error and
begins no Assignment Store write. The client never appends the Exposure. Disabled Flags, Flags without
a controlling Experiment, Experiments without a live Run, holdovers, and failed resolutions record no
new Exposure.
See [exposure-accessor.md](./exposure-accessor.md) for the full accessor contract.

The `peekVariant` accessor calls a **separate** peek endpoint that does NOT fire the Exposure.
Peek is a **server-side (API Key) path, not this public Client Key path** (ADR-0034): a silent,
SRM-invisible read under a public key is an allocation oracle. This public endpoint is
`evaluate`-only: callers cannot suppress the Exposure on a successful live-Run resolution. See
[exposure-accessor.md](./exposure-accessor.md).

## Init and lazy-fetch

- SDK instantiation succeeds immediately; no flag config is fetched at init time.
- The first `evaluate(flagKey)` call fetches from the endpoint and caches the resolved Variant
  in memory for subsequent calls within the session/instance (`reason: CACHED` on hits). A cache hit
  asynchronously posts privacy-minimal, non-billable telemetry so cached/local reporting dimensions
  remain visible. Its failure is loud in the SDK logger and never changes the cached result.
- If the endpoint is unreachable and no cached value exists, the SDK returns the **Default
  Variant** (CONTEXT.md) with `reason: ERROR` + an `errorCode` and
  emits a loud error log (ADR-0036). **This is never silent** — the caller can
  always tell a failure-fallback from a real resolution via `reason`. An uncertain request may
  already have committed its Exposure. A degraded-to-default
  result keeps the customer's app running; a _hidden_ one is forbidden.
- Single-flag-per-call. Bulk resolution is the separate non-exposing
  [`POST /api/sdk/evaluate-all`](./evaluate-all-endpoint.md) (Precomputed Evaluations, ADR-0048);
  this endpoint stays one Flag, one Exposure decision.

## Edge binding

Current Client Key requests enforce the following controls in the Worker (ADR-0018, ADR-0034):

- Origin/referrer allow-list enforcement per key. Auto-provisioned Client Keys start
  **open** (`origin_allowlist = null`) with loud open-state surfacing; locking to origins is an
  explicit one-action choice (see [credentials-and-keys.md](../control-plane/credentials-and-keys.md)
  and ADR-0034 §1).
- Per-key rate limiting through the Cloudflare Workers Rate Limiting binding, keyed on the credential
  hash plus route class.

The live Cloudflare Free WAF rule is a source-IP burst block for exact path `/agent/identity`; it does
not protect this endpoint. Host/method-scoped WAF enforcement, progressive challenge-before-block, and
per-credential header counters remain paid target-state debt. The SDK client must handle a current
Worker or future WAF rejection as non-retryable (`403`) or back-off (`429`).

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
  Default Variant with `reason: ERROR` and the wire or local transport error code, and logs loudly.
  A transport failure after durable acceptance cannot undo the Exposure; reuse the idempotency key
  when retrying an uncertain request. Not silent. The 503 carries a `Retry-After` header; the SDK does not auto-retry the
  Exposure-bearing call. An application retry must reuse its idempotency key for replay.
- **404 `FLAG_NOT_FOUND`** is a _failure_ too (a flagKey that does not exist is a setup bug,
  not a normal value): `reason: ERROR`, `errorCode: FLAG_NOT_FOUND`, no Exposure, loud.
- A flag that **exists but is disabled** or **has no Configuration in this Environment**, or
  whose targeting produced **no match**, is a legitimate resolution: the SDK returns the
  Default Variant with `reason: DISABLED` / `DEFAULT` (not `ERROR`) and the dev still learns
  why. These are normal, not alarmist.

`errorCode` preserves a valid HTTP `ErrorResponse.code`. Without a parsed server code, the SDK
maps the status as below. Local failures use `SDK_TRANSPORT_NETWORK`, `SDK_TRANSPORT_TIMEOUT`,
or `SDK_TRANSPORT_PARSE`. The OpenFeature provider separately maps these to OpenFeature codes.

### HTTP status to ResolutionDetails mapping

This is the contract that makes fail-loud **usable**: the SDK turns every transport outcome into a
structured [`ResolutionDetails`](../contracts/leaf-schemas-runtime.md#resolutiondetails-openfeature-sdk-return-shape)
the caller can branch on. The caller never has to inspect HTTP status itself.

| Transport outcome                    | `reason`   | `value`          | `errorCode`                          | Exposure                              |
| ------------------------------------ | ---------- | ---------------- | ------------------------------------ | ------------------------------------- |
| `200`, rule/rollout resolved         | `SPLIT`    | resolved Variant | —                                    | only a fresh live-Run resolution      |
| `200`, no rule matched               | `DEFAULT`  | Default Variant  | —                                    | only under a live Run                 |
| `200`, Flag disabled / no Env config | `DISABLED` | Default Variant  | —                                    | no                                    |
| in-memory cache hit                  | `CACHED`   | cached Variant   | —                                    | no                                    |
| `401` / `403`, without a parsed code | `ERROR`    | caller default   | `UNAUTHORIZED` / `FORBIDDEN`         | no                                    |
| `404 FLAG_NOT_FOUND`                 | `ERROR`    | caller default   | `FLAG_NOT_FOUND`                     | no                                    |
| `400 VALIDATION_ERROR`               | `ERROR`    | caller default   | `VALIDATION_ERROR`                   | no                                    |
| `429 RATE_LIMITED`                   | `ERROR`    | caller default   | `RATE_LIMITED`                       | no                                    |
| `503 SERVICE_UNAVAILABLE`            | `ERROR`    | caller default   | `SERVICE_UNAVAILABLE`                | may already be sealed                 |
| network / timeout / parse failure    | `ERROR`    | caller default   | corresponding `SDK_TRANSPORT_*` code | acceptance may already have committed |

Every `ERROR` row returns the **Default Variant** so the caller's UI still renders, carries a
non-null `errorCode`, and logs loudly — never a silent default (ADR-0036). The recommended caller
branch is a single check on `details.reason === 'ERROR'`.

## SDK initialization defaults

So a hello-world is genuinely copy-paste, the SDK ships sane defaults; each is overridable at
construction:

| Setting          | Default                                                             | Notes                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`       | `https://edge.splitch.dev` (the public Evaluation Worker, ADR-0038) | Override for self-hosted / preview Workers.                                                                                                                                |
| `timeoutMs`      | `5000`                                                              | Sized for a cold call, not a warm one: a first evaluation against healthy production measures ~2s. On timeout the SDK fails loud to the Default Variant (`reason: ERROR`). |
| `retries`        | `0` automatic retries; any other value throws `SDK_RETRIES_INVALID` | An application-managed retry supplies and reuses the same logical Evaluation idempotency key.                                                                              |
| `idType`         | `'user'`                                                            | Overridable per call.                                                                                                                                                      |
| `idempotencyKey` | a UUID generated with `crypto.randomUUID()` for each call           | Supply a non-empty key when the application manages retries. The wire header remains required.                                                                             |

```ts
import { createSplitchClient } from "@splitch/sdk";

// Minimal: paste keyMaterial from `splitch client-key get` (pk_…; not the ck_… keyId).
const splitch = createSplitchClient({ clientKey: "pk_..." });

// Hello-world resolution (idType defaults to 'user'):
const variant = await splitch.evaluate("new-checkout", {
  targetingKey: userId,
});

// Branch with details (fail-loud is one check):
const d = await splitch.evaluateDetails("new-checkout", {
  targetingKey: userId,
});
if (d.reason === "ERROR") renderFallback(d.errorCode);
else render(d.value);
```

## Seam contract

- **Port:** `evaluate(credential, flagKey, targetingKey, idType, attributes) -> VariantValue`
- **Left side:** SDK HTTP client (presents Client Key or API Key in the Authorization header)
- **Right side:** Worker that validates credential, loads Provider config + Assignment Store
  holdover, calls `assign()`, durably seals Exposure when required, then returns Variant value
- **Failure contract (fail-loud, ADR-0036):** credential invalid → 401; flag missing → 404 +
  Default Variant with `reason: ERROR`; Provider unreachable → 503 + Default Variant with
  `reason: ERROR`. Every failure-fallback carries `reason: ERROR` + `errorCode` and is
  logged loudly — never a silent default. The Exposure outbox seal precedes the Assignment Store
  write; Queue/Tinybird and the later DO write are not one distributed transaction (ADR-0006).
- **Logical Evaluation identity:** `Idempotency-Key` is required on this Exposure-bearing route.
  The SDK generates its value when the caller omits `idempotencyKey`. Applications that retry an
  uncertain request supply and reuse the same value for every attempt of the same logical
  Evaluation. The pipeline deduplicates usage rows by a scoped hash of that key for one UTC 24-hour
  replay window. The server does not infer retries from `requestId`, Targeting Key, or request shape;
  a new key is a new billable Evaluation.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0025](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — fail-loud, ResolutionDetails, idType default
- [ADR-0037](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — tiered verification
