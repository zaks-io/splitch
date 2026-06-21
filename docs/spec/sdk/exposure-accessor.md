# SDK exposure accessors: evaluate (fires Exposure) vs peekVariant (no Exposure)

Two accessors for reading a Variant. The default fires an Exposure as a structural side
effect. The explicit deferral path is a distinctly-named method — never a boolean parameter.

## The evaluate accessor (fires Exposure)

```
sdk.evaluate(flagKey: string, context: EvaluationContext): Promise<VariantValue>
```

Calling `evaluate` **always** fires an Exposure as a side effect. There is no way to call
`evaluate` without firing one (ADR-0004: the safe default eliminates the forget-to-expose bug).

**What happens inside:**
1. Validates context (targetingKey required).
2. Checks SDK seen-set for `(flagKey, runId, targetingKey)`. If present, returns cached
   Variant without an HTTP call and without a second Exposure.
3. On seen-set miss: calls `POST /apps/:appId/evaluate` (see [public-evaluate-endpoint.md](./public-evaluate-endpoint.md)).
4. Worker fires Exposure to raw log (server-side; client does not send a separate track call).
5. SDK updates seen-set with `(flagKey, runId, targetingKey) -> VariantValue`.
6. Returns resolved Variant.
7. On any error (network, 503): returns Default Variant without firing Exposure.

The Exposure fires in the Worker, not in the SDK client process. The client has no
"send exposure" step to forget.

## The peek accessor (no Exposure)

```
sdk.peekVariant(flagKey: string, context: EvaluationContext): Promise<VariantValue>
```

This accessor returns the resolved Variant **without firing an Exposure**. It is
distinctly named — `peekVariant` is not a variant of `evaluate` with a suppression flag
(ADR-0004: a suppressible side effect is the footgun these replace).

Peek is still a public Client Key path, so it returns only the Variant value. Resolution
reasons live on the control-plane test-evaluation endpoint, not the public SDK.

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
POST /apps/:appId/peek-evaluate
Authorization: Bearer <clientKey>
```

Request: same as `EvaluateRequest` (see [public-evaluate-endpoint.md](./public-evaluate-endpoint.md)).

Response:
```
PeekEvaluateResponse {
  variant: VariantValue
}
```

## Exposure row on the wire (Exposure pipeline schema cross-reference)

The Worker appends the following to the raw Exposure log on every `evaluate` call.
**The SDK does not own this schema** — it is owned by the [pipeline area spec](../pipeline/).
This table is a cross-reference only; do not duplicate the authoritative definition.

| Field | Type | Source |
|-------|------|--------|
| `app_id` | string | from auth context (not from client) |
| `experiment_id` | string | resolved from Flag's controlling Experiment |
| `run_id` | string | live Run at evaluation time (stamped at server-received time) |
| `targeting_key` | string | from request |
| `id_type` | string | from request |
| `variant_name` | string | Variant name (not value) — immutable experimental arm label |
| `server_ts` | timestamp | server-received-at (canonical for MIN(ts) first-touch) |
| `client_ts` | timestamp | client-fired time (diagnostics only; may have clock skew) |
| `type` | 'exposure' \| 'activation' | always 'exposure' here |

`run_id` is stamped **server-side at request time** (not at dedup time) to avoid race
conditions with Run closure. `variant_name` is the Variant name;
the Variant value is not logged (it is flag config, not event data).

## First-touch identity

The pipeline's first-touch identity is the tuple `(app_id, experiment_id, run_id, id_type, targeting_key)`,
resolved by `MIN(server_ts)` at query time. Multiple raw Exposures for the same Entity/Run share this
identity; the earliest `server_ts` is the authoritative first-touch row. The tuple deliberately excludes
`variant_name` — variant conflicts are caught by the `__multiple__` quarantine path (ADR-0011).

This is distinct from the wire-level `dedup_key` (a per-physical-row sha256 idempotency key for
at-least-once ingest); see [../pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).

## Seam boundary

- **Port (evaluate):** `evaluate(flagKey, context) -> VariantValue` — side effect: Exposure fired
- **Port (peek):** `peekVariant(flagKey, context) -> VariantValue` — no side effect
- **Left side:** SDK consumer (application code)
- **Right side:** Cloudflare Worker (calls Provider, Assignment Store, fires Exposure)
- **Failure contract:** network or server error → Default Variant returned, no Exposure fired
- **No manual exposure():** there is no `fireExposure(flagKey, variant)` call. Exposure is
  structural (fires on `evaluate`), not imperative. This is intentional (ADR-0004).
- **Deletion test:** both `evaluate` and `peekVariant` are real adapters on the
  "resolve Variant for this context" port; they differ by the exposure side effect.
  The seam is justified: two real paths with meaningfully different contracts.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
