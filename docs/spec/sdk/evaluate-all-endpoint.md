# Evaluate-all endpoint: `POST /api/sdk/evaluate-all` (Precomputed Evaluations, non-exposing)

The bulk data-plane endpoint behind static-context clients (ADR-0048). One call resolves **every
Flag in the credential's App and Environment** for one Evaluation Context and returns per-Flag
non-revealing [`ResolutionDetails`](https://openfeature.dev/specification/types/) — the
**Precomputed Evaluations** (CONTEXT.md). Structurally non-exposing, like `verify`; each fresh
live-Run assignment instead carries an **Exposure Ticket** the client redeems on first read
([exposures-endpoint.md](./exposures-endpoint.md)).

This is the endpoint the [browser client](./browser-client.md) inits and revalidates from, and the
server SDK's `evaluateAll(context)` calls to produce an SSR bootstrap.

## Endpoint

```
POST /api/sdk/evaluate-all
Authorization: Bearer <clientKey | apiKey>   -- either tier; disclosure does NOT scale (see below)
Content-Type: application/json
Idempotency-Key: <uuid>                      -- required; billing replay identity (see Billing)
If-None-Match: <etag>                        -- optional; revalidation
```

The **Environment is resolved from the credential**, never a request field (ADR-0027), and
**`app_id` authority is the credential alone** — no `:appId` path parameter; an optional body
`appId` is an assertion rejected `403 APP_MISMATCH` on mismatch and discarded on match. Both rules
mirror [public-evaluate-endpoint.md](./public-evaluate-endpoint.md) exactly.

## Request shape

`DataPlaneEvaluateRequest` minus `flagKey` — the Flag set is "all of them" (ADR-0048; no per-Flag
subscription config):

```
EvaluateAllRequest {
  targetingKey: string        -- required; the Entity identifier (CONTEXT.md: Targeting Key)
  idType:       string        -- required on the wire; SDK defaults it to 'user' (ADR-0036)
  attributes:   object        -- defaults to {}; attributes for Targeting Rule evaluation
}
```

## Response shape

```
EvaluateAllResponse {
  evaluations: {
    [flagKey: string]: {
      variant:        VariantValue | null   -- resolved value; null when no arm resolved
      variantName:    string | null          -- immutable arm label; public-safe (ADR-0018)
      reason:         Reason                 -- non-revealing set ONLY, every tier (see below)
      errorCode:      ErrorCode | null       -- non-null only when reason = ERROR
      exposureIdentity: string | null         -- opaque stable identity for the pending Exposure
      exposureTicket: string | null          -- non-null only for a fresh live-Run assignment
    }
  }
}
```

Standard wire conventions apply
([contracts/request-response-envelopes-conventions.md](../contracts/request-response-envelopes-conventions.md)):
optional fields are present-with-null, never omitted. The response carries a strong **`ETag`**
header computed over the canonical response body; `If-None-Match` with the current tag returns
`304` with an empty body. The tag changes when any contained resolution or pending Exposure identity
changes (config change, Experiment Run Start/End/rollover, holdover materialization) and is scoped to
`(credential, context)` — never reuse a tag across contexts. Exposure Ticket bytes remain outside
the validator. A non-serialized 12-hour refresh window changes the tag early enough to replace an
unread ticket before its 24-hour TTL can elapse; reminting the same pending Exposure at a later
`issued_at` inside one window does not create a false change.

`exposureIdentity` is present exactly when `exposureTicket` is present. It is an opaque HMAC over
the Exposure-relevant assignment and Experiment Run fields, excluding `issued_at`; clients compare
it as an indivisible string and cannot recover the Run, Targeting Key hash, rule identity, or ticket
payload from it. A same-Variant Experiment Run rollover changes the identity, while routine ticket
reminting for the same assignment does not. Holdover and non-exposing entries carry `null`. The
refresh window is ETag material only, never a response field, and therefore never changes browser
entry equality or re-arms an already-read Exposure.

`reason` reuses the `ResolutionReason` enum from
[contracts/leaf-schemas-runtime.md](../contracts/leaf-schemas-runtime.md); the server emits only
`SPLIT | DEFAULT | DISABLED | ERROR` here (`CACHED`/`STALE` are SDK-local states). Unlike
single-flag `evaluate` — whose wire body omits `reason` because the SDK synthesizes it from HTTP
status — a bulk response must carry `reason` per entry; the `verify` endpoint already returns this
set under a Client Key, so no new disclosure is introduced.

### Per-entry outcomes

| Resolution outcome                    | `reason`   | `exposureIdentity` | `exposureTicket` | Assignment Store                  |
| ------------------------------------- | ---------- | ------------------ | ---------------- | --------------------------------- |
| Fresh assignment under a live Run     | `SPLIT`    | identity           | ticket           | no write (deferred to redemption) |
| Holdover replay (prior Run, ADR-0006) | `SPLIT`    | `null`             | `null`           | read-only replay                  |
| Rule/rollout resolution, no live Run  | `SPLIT`    | `null`             | `null`           | —                                 |
| No rule matched → Default Variant     | `DEFAULT`  | `null`             | `null`           | —                                 |
| Flag disabled / no Environment config | `DISABLED` | `null`             | `null`           | —                                 |
| Per-Flag resolution failure           | `ERROR`    | `null`             | `null`           | —                                 |

A Flag that fails resolution **appears** in `evaluations` with `reason: ERROR` + `errorCode`; it is
never silently omitted (ADR-0036). A ticket's presence discloses only "reading this would create a
new Exposure" — a fact the caller could already derive by calling `evaluate` — never how the
Variant was chosen.

## Disclosure is destination-fixed, not credential-tiered

Both credential tiers receive the **same non-revealing reason set**. This deliberately differs from
`verify` (where an API Key sees `TARGETING_MATCH` + rule identity, ADR-0037): Precomputed
Evaluations are designed to be serialized into HTML for browser bootstrap
([browser-client.md](./browser-client.md)), so the payload's disclosure level must be safe for its
**destination** (a public page), regardless of which credential fetched it. An API Key holder who
wants rule identity uses `peek` or the control-plane test-eval (ADR-0026).

The response NEVER includes — same hard constraint as
[public-evaluate-endpoint.md](./public-evaluate-endpoint.md) (ADR-0018):

- Targeting Rules, conditions, or which rule matched
- Percentage Rollout allocation fractions or the salt
- Other Entities' assignments
- The Flag list beyond what the credential's Environment serves, or any Variant not resolved for
  this context (the full Variant catalog stays in the control plane)

## Resolution ordering

Per request (mirrors [assignment-store-integration.md](./assignment-store-integration.md), with the
commit step removed):

```
1. Validate credential (KV); resolve app_id + environment_id from it
2. Load Provider config for ALL Flags in the Environment (version-aware cache; committed changes
   propagate within five seconds)
3. held = AssignmentStore.getAll(appId, idType, targetingKey)     [ONE read for all Experiments]
4. For each Flag: resolve via the SAME evaluate-path resolver as `evaluate`
     - holdover in `held` -> replay variantName verbatim; no ticket
     - fresh live-Run assignment -> assign() (pure, ADR-0001); mint Exposure identity + Ticket
     - no seal, no AssignmentStore.put, no Exposure — structural (ADR-0048)
5. Compute ETag over the canonical body; return
```

There is **no second evaluation engine**: step 4 is the single resolver `evaluate` uses, invoked
per Flag. The route is wired to no Exposure or Assignment Store write path — the same structural
guarantee `verify` documents (ADR-0026 pattern).

## Billing (ADR-0033)

A successful `evaluate-all` that resolves N Flags consumes **N Evaluations** ("a batch request that
resolves 10 Flags consumes 10 Evaluations"). Local SDK reads of the result, bootstrap hydration,
and `304` revalidations consume **zero**. The required `Idempotency-Key` header is the billing
replay identity: retrying with the same key must not double-charge (ADR-0033 ledger rules). The SDK
mints a fresh UUID per logical fetch and reuses it for its own retry of that fetch; callers may
supply their own. Ticket redemption bills zero ("Exposure side effects consume zero extra").

## Edge binding (ADR-0034)

Identical to `evaluate`: Client Key requests pass the Cloudflare WAF (origin/referrer allow-list,
per-key rate limiting, progressive challenge) before the Worker; API Key requests are rate-limited
per key. One `evaluate-all` request is one request against the per-key counter. WAF rejections
return `403`/`429` before the Worker is invoked.

## Error responses (ADR-0025 shape)

Whole-request errors use the canonical `ErrorResponse`
([contracts/error-responses.md](../contracts/error-responses.md)); per-Flag failures ride inside
their entry (`reason: ERROR`) so one broken Flag cannot fail the fetch:

| HTTP status | `code`                | Meaning                                               |
| ----------- | --------------------- | ----------------------------------------------------- |
| 401         | `UNAUTHORIZED`        | Missing or invalid credential                         |
| 403         | `CREDENTIAL_REVOKED`  | Presented credential is revoked                       |
| 403         | `APP_MISMATCH`        | Credential does not belong to the asserted `appId`    |
| 403         | `ORIGIN_NOT_ALLOWED`  | Client Key request origin not on the key's allow-list |
| 400         | `VALIDATION_ERROR`    | Request body failed Zod parse                         |
| 429         | `RATE_LIMITED`        | Per-key rate limit exceeded (may be WAF-level)        |
| 503         | `SERVICE_UNAVAILABLE` | Provider config unresolvable as a whole; retryable    |

A transport-level failure fails the whole fetch loud; the SDK keeps serving its last-known-good
Precomputed Evaluations and surfaces the failure (`STALE`, [browser-client.md](./browser-client.md)) —
never a silent swap to defaults (ADR-0036).

## Seam contract

- **Port:** `evaluateAll(credential, evaluationContext) -> { evaluations, etag }` — no side effects
- **Left side:** browser client init/revalidation; server SDK `evaluateAll` (SSR bootstrap)
- **Right side:** Evaluation Worker: validates credential, loads all Flag configs (KV), reads
  holdovers once (`getAll`), resolves per Flag with the shared resolver, mints opaque Exposure
  identities and Exposure Tickets for fresh live-Run assignments; wired to NO write path
- **Failure contract:** per-Flag resolve failure → entry with `reason: ERROR` (fetch succeeds);
  whole-request failure → canonical error envelope, no partial body; ETag miss never fabricates a
  `304`
- **Deletion test:** passes — `evaluate` (single, exposing), `verify` (single, non-exposing,
  tiered), and `evaluate-all` (bulk, non-exposing, ticket-minting) are real adapters on the resolve
  port with meaningfully different contracts

## Sources

- [ADR-0048](../../adr/0048-precomputed-evaluations-decouple-resolution-from-exposure-via-exposure-tickets.md) — Precomputed Evaluations, Exposure Tickets
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md), [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md), [ADR-0033](../../adr/0033-v1-billing-is-an-organization-scoped-evaluation-quota.md), [ADR-0034](../../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md), [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [exposures-endpoint.md](./exposures-endpoint.md), [browser-client.md](./browser-client.md), [assignment-store-integration.md](./assignment-store-integration.md)
