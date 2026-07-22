# Verify endpoint: `POST /api/sdk/verify` (setup confirmation, tiered by credential)

The "is my setup correct?" data-plane endpoint (ADR-0037). Resolves a Flag and returns the
OpenFeature [`ResolutionDetails`](https://openfeature.dev/specification/types/) shape **without
firing an Exposure**, so a developer or agent can loop it during onboarding without polluting
analysis. What it reveals scales with the credential: a public Client Key sees only the
non-revealing `reason` set; an API Key sees the full resolution detail.

This is the lowest two tiers of the three verification tiers. The richest tier remains the
control-plane dry-run ([test-evaluation-endpoint.md](./test-evaluation-endpoint.md), ADR-0026).

## Why a separate endpoint and not `evaluate`

`evaluate` fires an Exposure as a structural side effect for every successful fresh assignment under
a live Experiment Run (ADR-0004). A setup loop built on `evaluate` would inject phantom Exposures into
the Run denominator once the Run is live. Verification must be
**structurally non-exposing**, like peek and the control-plane dry-run — there is no
"suppress exposure" flag a caller could set on `evaluate` (ADR-0026). `verify` is the distinct,
loudly-named path for "confirm reachability + configuration," same as `peekVariant` is the
distinct path for "resolve without exposing."

`verify` differs from `peekVariant`: `verify` is available on **every credential tier** (the
public Client Key included) and is purpose-built for onboarding confirmation; `peekVariant` is
**API-Key-only** (a silent resolve under a public key is an allocation oracle, ADR-0034) and is
for server-side below-the-fold / pre-computation use. See
[exposure-accessor.md](./exposure-accessor.md) for both accessors.

## Endpoint

```
POST /api/sdk/verify
Authorization: Bearer <clientKey | apiKey>   -- either tier; reveal scales with credential
Content-Type: application/json
```

The **Environment is resolved from the credential**, not a request field: both Client Keys and
API Keys are per `(app_id, environment_id)` (ADR-0027). The edge reads `environment_id` from the
key's validation-cache value to select which Environment's Flag Configuration and live
Experiment Runs to resolve against — identical to `evaluate`.

**`app_id` authority — credential is the sole source.** The route carries no `:appId` path
parameter. The only `app_id` that reaches Provider reads is the one bound to the validated
credential (ADR-0018). An optional body `appId` is an assertion: compared against the
credential and rejected `403 APP_MISMATCH` on mismatch, discarded on match — never a data scope.
This mirrors [public-evaluate-endpoint.md](./public-evaluate-endpoint.md) exactly.

## Request shape

Identical to `EvaluateRequest` (see [public-evaluate-endpoint.md](./public-evaluate-endpoint.md)):

```
VerifyRequest {
  flagKey:           string        -- required; Flag Key unique within the App
  targetingKey:      string        -- required; the Entity identifier (CONTEXT.md: Targeting Key)
  idType:            string        -- required on the wire; SDK defaults it to 'user' (ADR-0036)
  evaluationContext: {
    targetingKey: string           -- must equal top-level targetingKey
    [key: string]: unknown         -- arbitrary attributes for Targeting Rule Conditions
  }
}
```

Reusing the `evaluate` request shape is deliberate: a dev verifies with the **exact** call their
code will make, so a green verify means the real `evaluate` will resolve the same way (minus the
Exposure). The SDK applies the `idType: 'user'` default before sending, same as `evaluate`.

## Response shape

The OpenFeature `ResolutionDetails` shape (ADR-0036) — same as `evaluateDetails`:

```
VerifyResponse {
  variant:       VariantValue   -- the resolved Variant value (already public via evaluate, ADR-0018)
  variantName:   string         -- the Variant name (immutable arm label; public-safe)
  reason:        Reason         -- tiered by credential (see below)
  errorCode?:    ErrorCode      -- present only when reason = ERROR (OpenFeature enum)
  errorMessage?: string         -- present only when reason = ERROR
}
```

### Reason is tiered by credential (ADR-0037, ADR-0018)

Disclosure scales with credential trust — full stop. The public tier never hands the experiment
design to anyone holding the public key.

| Credential     | `reason` set                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Client Key** | Non-revealing only: `SPLIT` \| `DEFAULT` \| `DISABLED` \| `CACHED` \| `STALE` \| `ERROR`. Never names the matched rule. |
| **API Key**    | Full `ResolutionDetails` including `TARGETING_MATCH` and which Targeting Rule matched.                                  |

A rule-driven result under a Client Key reports `SPLIT` **without** naming the rule, the
allocation fraction, or the salt — the identical non-revealing constraint `evaluate` enforces.

## Fail-loud (ADR-0036)

`verify` uses the same fail-loud rule as `evaluate`: a failure to reach config returns
`reason: ERROR` + an `errorCode`, loudly (loud error log / error hook). A green verify is an
unambiguous `reason` in the success set — there is no silent "looks fine" that was actually a
fallback. A disabled / no-config / no-match Flag is **not** a failure: it returns the Default
Variant with `reason: DISABLED` / `DEFAULT`, no error. This is the whole point of `verify` —
the developer can tell "configured and resolving" apart from "reachable but misconfigured" apart
from "unreachable," every time.

## What it NEVER does (structural)

- Fires an Exposure to the raw log (structural — no write path is wired from this endpoint)
- Writes to the Assignment Store (DO or KV)
- Counts the Entity in any Run's analysis denominator
- Anchors a Conversion Window
- Under a Client Key: names the matched rule, returns allocation fractions, or returns the salt

Exposure-free is **structural at the endpoint level**, like the control-plane dry-run: the Worker
code path from `/api/sdk/verify` is wired to no write path. There is no flag a caller could omit
to accidentally fire an Exposure (ADR-0026).

## Holdover read (read-only diagnostic)

`verify` may read `AssignmentStore.getAll()` to reflect a returning Entity's sticky Variant
(same as `evaluate` reads holdovers), but it **never** calls `put()` — it is read-only. The
result therefore matches what `evaluate` would return for that Entity, holdover included, which
is what makes it a faithful setup check.

## Edge binding (ADR-0034)

`verify` is rate-limited and origin-bound exactly like `evaluate`:

- Client Key requests pass through Cloudflare WAF (origin/referrer allow-list, per-key rate
  limiting) before reaching the Worker. Client Keys are auto-provisioned open and locked down via
  `PATCH …/client-key`.
- API Key requests are rate-limited per key.

Because `verify` carries no richer information than `evaluate` already does (the Variant value is
public; the reason is tiered), it is **not** a silent allocation oracle — the same reasoning that
keeps `evaluate` safe under a public key (ADR-0034).

## Init and caching

Unlike `evaluate`, `verify` results are **not** stored in the SDK seen-set (same as `peekVariant`,
see [exposure-accessor.md](./exposure-accessor.md)): a subsequent `evaluate` for the same flag
fires an Exposure normally. `verify` leaves no trace in SDK instance state, so it never suppresses
a later real Exposure.

## Live config consistency

`verify` resolves against the **same KV-backed Provider config path** the `evaluate` endpoint
reads, so a green verify reflects the deployed truth the data plane serves — including the ~60s KV
propagation window after a Start (ADR-0009). If `verify` shows the old Variant for a few seconds
after Start, so does production. The verify step is honest about propagation rather than reading
D1 and reporting a Variant the edge cannot yet serve.

## SDK accessor and CLI surface

This endpoint backs the `verify` SDK accessor (full contract in
[exposure-accessor.md](./exposure-accessor.md)):

```
sdk.verify(flagKey: string, context: EvaluationContext): Promise<ResolutionDetails>
```

It surfaces in the CLI for developers testing with the credential their code holds:

```
splitch flags verify [--app <app_id>] [--env <environment_id>] <flag_id> --targeting-key <key> [--context-json <json>]
```

`verify` is **not** an MCP tool — like `evaluate`, it is a data-plane endpoint called by SDK
clients, not agents. The agent's verification path is the control-plane `flags_test_eval` tool
(the richest tier, ADR-0026). See
[../contracts/mcp-tool-derivation.md](../contracts/mcp-tool-derivation.md).

## Error responses (ADR-0025 shape)

All errors use the shared `ErrorResponse` shape (canonical registry:
[../contracts/error-responses.md](../contracts/error-responses.md)):

| HTTP status | `code`                | Meaning                                                      |
| ----------- | --------------------- | ------------------------------------------------------------ |
| 401         | `UNAUTHORIZED`        | Missing or invalid credential                                |
| 403         | `CREDENTIAL_REVOKED`  | Presented credential is revoked                              |
| 403         | `APP_MISMATCH`        | Credential does not belong to the asserted `appId`           |
| 403         | `ORIGIN_NOT_ALLOWED`  | Client Key request origin not on the key's allow-list        |
| 404         | `FLAG_NOT_FOUND`      | `flagKey` does not exist in this App / Environment           |
| 400         | `VALIDATION_ERROR`    | Request body failed Zod parse                                |
| 429         | `RATE_LIMITED`        | Per-key rate limit exceeded                                  |
| 503         | `SERVICE_UNAVAILABLE` | Provider config unresolvable; retryable (Retry-After header) |

A config-resolution failure is reported two ways by design: a transport/`503` failure surfaces as
an HTTP error, while an in-band resolve failure returns `200` with `reason: ERROR` + `errorCode`
(fail-loud, ADR-0036). The SDK accessor normalizes both into `ResolutionDetails` so the caller
always reads one shape. Like `evaluate`, the SDK does **not** auto-retry; the caller decides.

Note: `verify` never returns `RUN_FROZEN` or other operational 409s (it is a read, not a mutation)
and never returns `INSUFFICIENT_SCOPES` under a Client Key (the Client Key structurally holds
`evaluate`, which covers verify).

## Seam boundary

- **Port:** `verify(credential, flagKey, evaluationContext) -> ResolutionDetails` — no Exposure side effect
- **Left side:** SDK consumer (application code) / CLI `flags verify`, with the credential their code holds
- **Right side:** Worker that reads live config from the same KV-backed Provider path as
  `evaluate`, may read holdover (read-only), computes resolution, returns `ResolutionDetails`
  tiered by credential; wired to NO write path
- **Failure contract:** no writes on any path; transport failure → `reason: ERROR` + `errorCode`
  (or `503` for unresolvable Provider); `404` → flag not found; `401`/`403` → auth failure
- **Deletion test:** passes — `evaluate` (Exposure-bearing), `verify` (non-exposing, tiered),
  `peekVariant` (non-exposing, API-Key-only), and the control-plane dry-run are four real
  adapters on the "resolve a Variant" port, differing in auth, exposure side effect, and reason
  disclosure

## Sources

- [ADR-0037](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — verify tiered by credential
- [ADR-0004](../../adr/0004-exposure-fires-on-read.md) — verification is structurally non-exposing
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md) — public key never reveals rules/allocation
- [ADR-0026](../../adr/0026-test-evaluation-endpoint-dry-run-never-exposes.md) — control-plane reason-revealing dry-run (richest tier)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md) — Environment resolved from the credential
- [ADR-0034](../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md) — verify is rate-limited / origin-bound like evaluate
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — fail-loud, ResolutionDetails, non-revealing reason set
