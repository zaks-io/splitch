# SDK accessors: evaluate / evaluateDetails (fire Exposure), peekVariant + verify (no Exposure)

Accessors for reading a Variant. `evaluate` and `evaluateDetails` fire an Exposure as a
structural side effect; `peekVariant` and `verify` do not. The non-exposing paths are
distinctly-named methods — never a boolean parameter on `evaluate`. Every accessor speaks the
OpenFeature [`ResolutionDetails`](https://openfeature.dev/specification/types/) shape under
the hood (ADR-0036); the value accessors just unwrap it to the Variant value.

## EvaluationContext and the idType default

```
EvaluationContext {
  targetingKey: string         -- required; the Entity identifier (CONTEXT.md: Targeting Key)
  idType?:      string         -- optional in the SDK; defaults to 'user'. Required on the wire,
                               -- so the SDK fills the default before sending (ADR-0036).
  [key: string]: unknown       -- arbitrary attributes for Targeting Rule Conditions
}
```

The hello-world call is therefore `sdk.evaluate(flagKey, { targetingKey })`. Override the
bucketing unit with `{ targetingKey, idType: 'workspace' }` when bucketing on something other
than a user.

## The evaluate accessor (fires Exposure)

```
sdk.evaluate(flagKey: string, context: EvaluationContext): Promise<VariantValue>
sdk.evaluateDetails(flagKey: string, context: EvaluationContext): Promise<ResolutionDetails>
```

`evaluate` returns the resolved Variant value; `evaluateDetails` returns the full OpenFeature
`ResolutionDetails` (`value`, `variantName`, `reason`, `errorCode?`, `errorMessage?`). Both
**always** fire an Exposure as a side effect — there is no way to call them without firing one
(ADR-0004: the safe default eliminates the forget-to-expose bug). Use `evaluateDetails` to
branch on `reason` / `errorCode` (e.g. surface a banner on `STALE`, throw in your own code on
`ERROR`).

**What happens inside:**

1. Validates context (targetingKey required; idType defaulted to 'user' if omitted).
2. Checks SDK seen-set for `(flagKey, runId, targetingKey)`. If present, returns cached
   Variant without an HTTP call and without a second Exposure (`reason: CACHED`).
3. On seen-set miss: calls `POST /api/sdk/evaluate` (see [public-evaluate-endpoint.md](./public-evaluate-endpoint.md)).
4. Worker fires Exposure to raw log (server-side; client does not send a separate track call).
5. SDK updates seen-set with `(flagKey, runId, targetingKey) -> VariantValue`.
6. Returns resolved Variant (or full details).
7. **On failure (network, 503, 404): returns Default Variant with `reason: ERROR` + an
   `errorCode`, fires NO Exposure, and emits a loud error log / error hook (ADR-0036). Never
   silent** — the caller can always distinguish a failure-fallback from a real resolution. A
   _disabled / no-config / no-match_ flag is not a failure: it returns the Default Variant
   with `reason: DISABLED` / `DEFAULT`, no error.

The Exposure fires in the Worker, not in the SDK client process. The client has no
"send exposure" step to forget.

## The peek accessor (no Exposure)

```
sdk.peekVariant(flagKey: string, context: EvaluationContext): Promise<VariantValue>
```

This accessor returns the resolved Variant **without firing an Exposure**. It is
distinctly named — `peekVariant` is not a variant of `evaluate` with a suppression flag
(ADR-0004: a suppressible side effect is the footgun these replace).

**Peek is a server-side (API Key) path, not a public Client Key path (ADR-0034).** A read
that resolves a Variant while firing no Exposure leaves no SRM trace, which under a public
Client Key is a silent allocation oracle: sweep Targeting Keys, read each variant, and
reconstruct the rollout without polluting analysis or tripping SRM. So `peekVariant` requires
an **API Key** (trusted server runtime). The public Client Key keeps exactly one capability —
Exposure-bearing `evaluate`. Client-side below-the-fold deferral is served by firing
`evaluate` when the element scrolls into view, not by a silent client peek. Peek still returns
only the Variant value; resolution reasons live on the control-plane test-evaluation endpoint.

**Peek does NOT:**

- Write to the Exposure log
- Write to the Assignment Store
- Count the Entity in any Run's analysis denominator
- Anchor a Conversion Window

**Peek use cases:**

- Below-the-fold UI (peek to decide layout; `evaluate` when the user scrolls to see it)
- Server-side pre-computation before client-side evaluation
- Conditional rendering that should only expose after a meaningful interaction

**Peek and the seen-set:** peek results are NOT stored in the seen-set. A subsequent
`evaluate` call for the same flag will fire an Exposure normally. Peek leaves no trace
in the SDK instance state.

## Peek endpoint shape

```
POST /api/sdk/peek
Authorization: Bearer <apiKey>      -- API Key (server-side), NOT a Client Key (ADR-0034)
```

A Client Key presented to this endpoint is rejected `403 INSUFFICIENT_SCOPES` (the key is valid but
structurally lacks the peek scope; a missing/invalid credential is `401 UNAUTHORIZED`). The Worker
gates peek on an API Key's `data-plane:evaluate` scope, the same credential the server-side SDK holds.

All other error responses (`400 VALIDATION_ERROR`, `404 NOT_FOUND` for an unknown Flag,
`429 RATE_LIMITED`, `503` on an unreachable Provider) follow the canonical error contract in
[contracts/error-responses.md](../contracts/error-responses.md) — peek does not define its own. Unlike
`evaluate`, peek has no Default-Variant fallback: disabled, no-live-Run, null-Experiment, and
no-match-default resolutions fail loud with the error envelope (peek is a server-side
authoring/diagnostic call, never a hot-path resolution).

Request: same as `EvaluateRequest` (see [public-evaluate-endpoint.md](./public-evaluate-endpoint.md)).

Response:

```
PeekEvaluateResponse {
  variant: VariantValue
}
```

## The verify accessor (no Exposure) — setup confirmation

```
sdk.verify(flagKey: string, context: EvaluationContext): Promise<ResolutionDetails>
```

`verify` is the "is my setup correct?" call (ADR-0037). It resolves the Flag and returns
`ResolutionDetails` **without firing an Exposure**, so a dev or agent can loop it during setup
without polluting analysis. It is distinct from `peekVariant` in intent: `verify` is for
confirming reachability + configuration during onboarding, and is available on **every
credential tier** (unlike peek, which is API-Key-only).

What `verify` reveals scales with the credential (ADR-0037):

- **Client Key:** Variant value + `reason` from the non-revealing set only (`SPLIT`,
  `DEFAULT`, `DISABLED`, `CACHED`, `STALE`, `ERROR`). Never names the matched rule (ADR-0018).
- **API Key:** full `ResolutionDetails` including `TARGETING_MATCH` and which rule matched.
- The control-plane test-evaluation endpoint (ADR-0026) remains the richest tier.

`verify` is fail-loud like `evaluate`: an unreachable config returns `reason: ERROR` +
`errorCode`, loudly. A green verify is an unambiguous success `reason`, never a disguised
fallback.

## Exposure row on the wire (Exposure pipeline schema cross-reference)

The Worker appends the following to the raw Exposure log on every `evaluate` call.
**The SDK does not own this schema** — it is owned by the [pipeline area spec](../pipeline/).
This table is a cross-reference only; do not duplicate the authoritative definition.

| Field                | Type                       | Source                                                             |
| -------------------- | -------------------------- | ------------------------------------------------------------------ |
| `event_id`           | string                     | generated once by the Worker when it creates the raw row           |
| `dedup_key`          | string                     | sha256 over row type, identity fields, source id, and event id     |
| `app_id`             | string                     | from auth context (not from client)                                |
| `environment_id`     | string                     | from the SDK key's Environment (co-scoped with `app_id`, ADR-0027) |
| `experiment_id`      | string                     | resolved from Flag's controlling Experiment                        |
| `run_id`             | string                     | live Run at evaluation time (stamped at server-received time)      |
| `targeting_key_hash` | string                     | derived server-side from request Targeting Key                     |
| `id_type`            | string                     | validated request `idType`; must match the Run config              |
| `variant`            | string                     | Variant name (not value) — immutable experimental arm label        |
| `source_id`          | string                     | edge POP identifier                                                |
| `server_ts`          | timestamp                  | server-received-at (canonical for MIN(ts) first-touch)             |
| `ingest_ts`          | timestamp                  | raw-log append watermark; never used for first-touch               |
| `client_ts`          | timestamp                  | client-fired time (diagnostics only; may have clock skew)          |
| `type`               | 'exposure' \| 'activation' | always 'exposure' here                                             |

`run_id` is stamped **server-side at request time** (not at dedup time) to avoid race
conditions with Run closure. `variant` is the Variant name;
the Variant value is not logged (it is flag config, not event data).

## First-touch identity

The pipeline's first-touch identity is the tuple `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`
(`environment_id` co-scoped with `app_id`; Exposures are per-Environment, ADR-0027),
resolved by `MIN(server_ts)` at query time. Multiple raw Exposures for the same Entity/Run share this
identity; the earliest `server_ts` is the authoritative first-touch row. The tuple deliberately excludes
`variant` — variant conflicts are caught by the `__multiple__` quarantine path (ADR-0011).

This is distinct from the wire-level `dedup_key` (a per-physical-row sha256 idempotency key for
at-least-once ingest); see [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).

## Seam boundary

- **Port (evaluate):** `evaluate(flagKey, context) -> VariantValue` / `evaluateDetails(...) -> ResolutionDetails` — side effect: Exposure fired
- **Port (peek):** `peekVariant(flagKey, context) -> VariantValue` — no side effect (API Key only)
- **Port (verify):** `verify(flagKey, context) -> ResolutionDetails` — no side effect (all tiers, ADR-0037)
- **Left side:** SDK consumer (application code)
- **Right side:** Cloudflare Worker (calls Provider, Assignment Store, fires Exposure)
- **Failure contract (fail-loud, ADR-0036):** for `evaluate` and `verify`, network or server
  failure returns the Default Variant with `reason: ERROR` + `errorCode`, fires no Exposure, and
  emits a loud error log/hook. Never a silent default. Disabled/no-config/no-match returns the
  Default Variant with `reason: DISABLED`/`DEFAULT`. Peek is stricter: failures and Default Variant
  fallbacks return the canonical error envelope instead of a Variant value.
- **No manual exposure():** there is no `fireExposure(flagKey, variant)` call. Exposure is
  structural (fires on `evaluate`), not imperative. This is intentional (ADR-0004).
- **Deletion test:** both `evaluate` and `peekVariant` are real adapters on the
  "resolve Variant for this context" port; they differ by the exposure side effect.
  The seam is justified: two real paths with meaningfully different contracts.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0034](../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md) — peek behind the API Key
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — fail-loud, ResolutionDetails, evaluateDetails, idType default
- [ADR-0037](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — verify accessor, tiered by credential
