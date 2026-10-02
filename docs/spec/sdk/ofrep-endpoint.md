# OFREP endpoints: `POST /ofrep/v1/evaluate/flags/{key}` and `POST /ofrep/v1/evaluate/flags`

OFREP Core (OpenFeature Remote Evaluation Protocol) on the Evaluation Worker. The two
paths reuse the same evaluation core and credential auth as
[`POST /api/sdk/evaluate`](./public-evaluate-endpoint.md) and
[`POST /api/sdk/evaluate-all`](./evaluate-all-endpoint.md). Those existing endpoints
do not change.

The protocol text is the Core section of
[github.com/open-feature/protocol](https://github.com/open-feature/protocol)
(`service/openapi.yaml`). Auth is a Client Key or API Key as `Authorization: Bearer`
or `X-API-Key`. The Environment is the credential's, never a request field.

## Single-Flag evaluation

```
POST /ofrep/v1/evaluate/flags/{key}
Authorization: Bearer <clientKey | apiKey>
Content-Type: application/json
Idempotency-Key: <optional>
```

```
{ "context": { "targetingKey": "user-1", "idType": "user", "plan": "pro" } }
```

`idType` is optional and defaults to `user`. Other context fields become Targeting
attributes. Nested object attributes fail `INVALID_CONTEXT`.

This path is Exposure-bearing, same as `evaluate`. A successful resolution that
assembles an Exposure writes that Exposure and one Evaluation.

### Success (200)

```
{ "key": "new-checkout", "value": true, "reason": "SPLIT", "variant": "treatment" }
```

Splitch Resolution Details map as:

| splitch `reason`  | OFREP field                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `SPLIT`           | `reason: SPLIT`                                                                                |
| `TARGETING_MATCH` | `reason: TARGETING_MATCH` (API Key / control-plane only; this public path stays non-revealing) |
| `DEFAULT`         | `reason: STATIC`                                                                               |
| `DISABLED`        | `reason: DISABLED`                                                                             |
| `ERROR`           | evaluation failure (`errorCode`, no `value`)                                                   |
| null Variant      | OFREP code-default: `value` omitted so the provider uses its code default                      |

`variant` is the Variant name. `metadata` is omitted on this path.

### Evaluation failures

| HTTP | OFREP `errorCode`       | When                                                               |
| ---- | ----------------------- | ------------------------------------------------------------------ |
| 400  | `TARGETING_KEY_MISSING` | `context.targetingKey` missing or empty                            |
| 400  | `INVALID_CONTEXT`       | context is not an object, or an attribute is not a scalar or array |
| 400  | `PARSE_ERROR`           | body is not a JSON object                                          |
| 404  | `FLAG_NOT_FOUND`        | unknown Flag Key                                                   |
| 400  | `GENERAL`               | other per-Flag evaluation errors                                   |

Auth, origin, and rate-limit failures keep the existing splitch `ErrorResponse`
envelope (`UNAUTHORIZED`, `CREDENTIAL_REVOKED`, `ORIGIN_NOT_ALLOWED`,
`RATE_LIMITED`). Those are Worker credential gates, not OFREP evaluation failures.

## Bulk evaluation

```
POST /ofrep/v1/evaluate/flags
Authorization: Bearer <clientKey | apiKey>
Content-Type: application/json
If-None-Match: <etag>
Idempotency-Key: <optional>
```

Resolves every Flag in the credential's App and Environment for one Evaluation
Context. Same resolver as `evaluate-all`. Structurally non-exposing.

### Success (200)

```
{
  "flags": [
    { "key": "new-checkout", "value": true, "reason": "SPLIT", "variant": "treatment", "metadata": { "exposureTicket": "...", "exposureIdentity": "..." } },
    { "key": "theme", "reason": "STATIC", "variant": "default" }
  ]
}
```

A strong `ETag` is computed over the same material as `evaluate-all`. Matching
`If-None-Match` returns `304` with an empty body.

Per-Flag failures stay in `flags` as `{ key, errorCode, errorDetails }`. A whole
request that cannot load Provider config fails as `503 SERVICE_UNAVAILABLE`.

## Exposure for a prefetched bulk value

Bulk OFREP does not record Exposure. A fresh live-Run assignment carries
`metadata.exposureTicket` and `metadata.exposureIdentity`, the same vouchers
`evaluate-all` mints (ADR-0048).

Exposure is recorded when a caller redeems that ticket on
[`POST /api/sdk/exposures`](./exposures-endpoint.md), which is what the browser
client does on first local read. A community OFREP web provider that ignores
`metadata` will not record Exposure for a cached bulk value. That is a recording
gap, not a billing change: redeeming a ticket still consumes zero Evaluations.

Single-Flag OFREP records Exposure on the request, because that request is the
read.

## Billing (ADR-0033, unchanged)

- One successful single-Flag OFREP Evaluation consumes one Evaluation.
- A successful bulk fetch of N Flags consumes N Evaluations.
- `304` revalidations and later local reads of a cached bulk payload consume zero.
- Failed requests consume zero.
- Exposure side effects consume zero extra. Ticket redemption consumes zero extra.
- Metric Event `track` from the OFREP provider consumes zero Evaluations.

`Idempotency-Key` is optional. When present it is the billing replay identity.
When absent the Worker mints a per-request key, so an OFREP client retry without
the header is a new logical Evaluation.

## OpenFeature provider

`@splitch/sdk/openfeature` exports `SplitchOfrepProvider`. It POSTs single-Flag
OFREP for each typed resolve and maps `track()` to `POST /api/sdk/events`
(Metric Events). Hook lifecycle and a full `@openfeature/server-sdk` dependency
stay deferred ([openfeature-deferred.md](./openfeature-deferred.md)).

## Sources

- [ADR-0033](../../adr/0033-v1-billing-is-an-organization-scoped-evaluation-quota.md)
- [ADR-0036](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [ADR-0048](../../adr/0048-precomputed-evaluations-decouple-resolution-from-exposure-via-exposure-tickets.md)
- [ADR-0059](../../adr/0059-ofrep-core-is-a-data-plane-projection-of-evaluate.md)
- [OpenFeature protocol](https://github.com/open-feature/protocol)
