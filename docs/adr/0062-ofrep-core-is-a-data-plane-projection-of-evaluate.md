# OFREP Core is a data-plane projection of evaluate and evaluate-all

**Status:** accepted

OFREP Core (OpenFeature Remote Evaluation Protocol) is the vendor-neutral HTTP
shape generic OpenFeature providers already speak. splitch already resolves Flags
through one evaluation core and already returns OpenFeature-shaped Resolution
Details. A second evaluation engine would drift. This ADR adds OFREP as a
projection of the existing evaluate and evaluate-all paths.

## Decision

1. Mount OFREP Core at `POST /ofrep/v1/evaluate/flags/{key}` and
   `POST /ofrep/v1/evaluate/flags` on the Evaluation Worker.
2. Authenticate with the existing Client Key or API Key (`Authorization: Bearer`
   or `X-API-Key`). The Environment stays the credential's.
3. Single-Flag OFREP is Exposure-bearing, like `evaluate`.
4. Bulk OFREP is a non-exposing prefetch, like `evaluate-all`. Exposure Tickets
   ride in OFREP `metadata` so first local read can redeem them. Prefetch itself
   records no Exposure.
5. Billing follows ADR-0033 exactly: N Flags in a bulk fetch consume N
   Evaluations; cached and `304` reads consume zero; Exposure side effects
   consume zero extra. ADR-0033 is not amended.
6. Ship `SplitchOfrepProvider` on `@splitch/sdk/openfeature`. It talks OFREP for
   typed resolve and maps `track()` to Metric Events. The full OpenFeature hook
   lifecycle stays deferred.

## Consequences

A community OFREP web provider that ignores `metadata` will not record Exposure
for a cached bulk value. That is documented, not papered over with a silent
Exposure on prefetch (which would count unused Flags as exposed).

`Idempotency-Key` is optional on OFREP because the protocol does not send it. A
retry without the header is a new logical Evaluation.

## Sources

- [ADR-0033](./0033-v1-billing-is-an-organization-scoped-evaluation-quota.md)
- [ADR-0036](./0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [ADR-0048](./0048-precomputed-evaluations-decouple-resolution-from-exposure-via-exposure-tickets.md)
- [OFREP protocol](https://github.com/open-feature/protocol)
