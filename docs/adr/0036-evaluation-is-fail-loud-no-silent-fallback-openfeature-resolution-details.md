# Evaluation is fail-loud: no silent fallback, OpenFeature ResolutionDetails everywhere

**Status:** accepted

A flag evaluation that quietly returns the Default Variant on a backend failure is the
single worst DX bug a flag platform can ship: the customer's app keeps running on the wrong
value and there is nothing in the system that says so. splitch forbids it. Every evaluation
result is **observable and self-explaining** — it carries the OpenFeature
[`ResolutionDetails`](https://openfeature.dev/specification/types/) shape
(`value`, `variant`, `reason`, `errorCode?`, `errorMessage?`, `flagMetadata`), and a result
that fell back because of a **failure** always carries `reason: ERROR` plus an `errorCode`
and is emitted on a loud error log/hook. A silent default is a contract violation, not a
degraded mode.

This is OpenFeature best practice followed verbatim, not invented (ADR-0025 commits splitch
to building on the OpenFeature standard). It partially reopens
[openfeature-deferred.md](../spec/sdk/openfeature-deferred.md) items 6 (typed details) and the
`reason`/error surface — the rest of the OpenFeature provider surface stays deferred.

## The two accessors

- `evaluate(flagKey, context) -> VariantValue` — the value-only ergonomic accessor. On an
  unresolvable failure it returns the Default Variant **so a backend outage degrades the
  customer's render path to the default instead of crashing it** (OpenFeature's deliberate
  resilience posture), but it does so loudly: the SDK emits a mandatory error log / error
  hook with `errorCode` and `errorMessage`. It never returns a failure value that is
  indistinguishable from a real resolution.
- `evaluateDetails(flagKey, context) -> ResolutionDetails` — the full OpenFeature details
  accessor. Code that wants to branch on `reason` / `errorCode` (e.g. show a banner on
  `STALE`, fail a health check on `ERROR`) reads it here. This is the debuggable surface.

"Fail loud" therefore means **always observable, never disguised** — it does not mean
"throw and break the page." A caller who wants hard-throw semantics inspects
`details.reason === 'ERROR'` and throws in their own code.

## Failure vs. legitimate default — the dividing line

`reason: ERROR` is reserved for genuine **failure to resolve**: provider unreachable, config
unparseable, credential invalid at the data-plane boundary. A flag that is **disabled**, has
**no Configuration in this Environment**, or whose targeting produced **no match** is a
legitimate resolution that returns the Default Variant with `reason: DISABLED` / `DEFAULT` —
not an error. The developer still learns _why_ they got the default from `reason`, so it is
debuggable without being alarmist. (Confirmed product decision: misconfiguration is a normal
`DEFAULT`, infrastructure failure is loud `ERROR`.)

splitch maps its internal resolution outcomes onto the OpenFeature standard `reason` enum:

| splitch outcome                            | OpenFeature `reason` |
| ------------------------------------------ | -------------------- |
| Fractional / percentage assignment         | `SPLIT`              |
| Targeting Rule matched                     | `TARGETING_MATCH`    |
| Served from seen-set / in-memory cache     | `CACHED`             |
| Flag disabled in this Environment          | `DISABLED`           |
| No rule matched → Default Variant          | `DEFAULT`            |
| Config propagation lag / non-authoritative | `STALE`              |
| Provider/network/parse failure             | `ERROR` (+errorCode) |

## Public reveals nothing; API Key / control plane reveals everything (ADR-0018 preserved)

Under a **public Client Key** the `reason` collapses to the non-revealing set
(`SPLIT`, `DEFAULT`, `DISABLED`, `CACHED`, `STALE`, `ERROR`) and **never** discloses _which_
Targeting Rule matched or any allocation detail — disclosing that under a public key is the
reverse-engineering / allocation-oracle risk ADR-0018 and ADR-0034 close. The full,
rule-naming reason detail is available only behind an **API Key** or the **control-plane
token** (the test-evaluation endpoint, ADR-0026). `TARGETING_MATCH` is therefore an
API-Key/control-plane reason; under a Client Key a rule-driven result reports `SPLIT` or
`TARGETING_MATCH` without naming the rule.

## Considered options

- **Keep the silent Default-Variant fallback** — rejected: it is undebuggable by
  construction and violates the project's fail-loud principle. The customer cannot tell a
  real value from a fallback.
- **Throw on every failure** — rejected as the _default_ `evaluate` behavior: an unhandled
  transient edge error would break the customer's render path. The value accessor degrades
  loudly; `evaluateDetails` + the error hook give callers who want to throw the signal to do
  so.
- **Invent a splitch-specific reason/detail shape** — rejected: OpenFeature already defines
  `ResolutionDetails` and a standard `reason`/`errorCode` enum, and ADR-0025 commits us to the
  standard. Conform, don't fork.

## Consequences

- `exposure-accessor.md` and `public-evaluate-endpoint.md` lose all "returns Default Variant
  silently / without indication" language; the data-plane response and SDK accessors carry
  `reason`/`errorCode`. A `reason: ERROR` result fires **no Exposure** (it is not a real
  encounter), same as before — but it is now loud.
- The data-plane `EvaluateResponse` gains the non-revealing details fields; the peek and
  test-eval responses gain the full details (behind API Key / control-plane, ADR-0026).
- `errorCode` uses the OpenFeature standard enum (`PROVIDER_NOT_READY`, `FLAG_NOT_FOUND`,
  `PARSE_ERROR`, `TYPE_MISMATCH`, `TARGETING_KEY_MISSING`, `INVALID_CONTEXT`,
  `PROVIDER_FATAL`, `GENERAL`), mapped from the existing `ErrorResponse.code` at the SDK
  boundary (ADR-0025).
- This is a contract type (ADR-0025, Zod-first): one `ResolutionDetails` schema in
  `@splitch/contracts`, rendered identically by every skin.

## Sources

- [ADR-0004](0004-exposure-fires-on-read.md) — Exposure fires on read; a fail-loud ERROR result fires none
- [ADR-0018](0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md) — public key reveals only the Variant, never rules/allocation
- [ADR-0025](0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md) — build on OpenFeature; one Zod contract everywhere
- [ADR-0026](0026-test-evaluation-endpoint-dry-run-never-exposes.md) — full resolution reason lives behind the control-plane token
- [ADR-0034](0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md) — allocation-oracle closure
- [OpenFeature types](https://openfeature.dev/specification/types/) — ResolutionDetails, standard reason and error-code enums
