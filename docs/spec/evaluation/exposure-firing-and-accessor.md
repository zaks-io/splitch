# Exposure firing and evaluate-path accessor contract

Reading a Variant through the SDK fires an Exposure as a side effect. Deferral is a
distinct, loudly-named accessor. There is no middle path — no boolean flag to suppress
Exposure, no forget-to-fire footgun.

This file describes the **evaluate-path** side of the seam (Exposure assembly, holdover
short-circuit, the internal `EvaluateResult` that carries `liveRunId`/`isHoldover`). The
**public SDK accessor surface** — exact method names, the OpenFeature `ResolutionDetails`
return shape, the fail-loud failure contract, `evaluateDetails`, and `verify` — is owned by
[../sdk/exposure-accessor.md](../sdk/exposure-accessor.md). Names here match that file
verbatim (one name per concept, no synonyms).

## Accessors

```
// Evaluates the Flag and fires an Exposure as a side effect.
// SAFE DEFAULT. Use unless you specifically intend to defer.
sdk.evaluate(flagKey, context)          -> VariantValue        (fires Exposure)
sdk.evaluateDetails(flagKey, context)   -> ResolutionDetails   (fires Exposure; ADR-0036)

// Resolve WITHOUT firing an Exposure. Distinct method names, never a parameter on evaluate().
sdk.peekVariant(flagKey, context)       -> VariantValue        (API Key only; ADR-0034)
sdk.verify(flagKey, context)            -> ResolutionDetails   (setup confirmation; ADR-0037)
```

Internally each returns an `EvaluateResult` (carrying `liveRunId`, `isHoldover`, the resolved
Variant, and the `reason`); the public value accessors unwrap it. `peekVariant`/`verify` are
distinct method names, not a parameter on `evaluate()`. A `{ withoutExposure: true }` boolean
option is rejected — it is the suppressible-flag footgun ADR-0004 designed out.

**Fail-loud (ADR-0036):** on a resolution _failure_ (provider unreachable, KV miss, network),
`evaluate()` returns the Default Variant with `reason: ERROR` + `errorCode`, fires no Exposure,
and logs loudly — never a silent default. A disabled / no-config / no-match flag is a normal
`DISABLED`/`DEFAULT`, not an error. See [../sdk/exposure-accessor.md](../sdk/exposure-accessor.md).

## Exposure fires on read

Calling `sdk.evaluate()` fires one Exposure event as an immediate side effect. The Entity
**cannot** branch on the Variant without having been exposed. This eliminates the #1
real-world experimentation bug: evaluate, branch, forget to fire Exposure → silent,
often Variant-differential under-exposure.

The side effect **must be documented prominently** in the SDK reference.

## Exposure event shape

| Field              | Type     | Required | Meaning                                                                                    |
| ------------------ | -------- | -------- | ------------------------------------------------------------------------------------------ |
| `eventId`          | string   | yes      | Retry-stable physical raw-row id generated once before any retry                           |
| `dedupKey`         | string   | yes      | Wire-level idempotency key; hashes row type, identity fields, source id, and `eventId`     |
| `appId`            | string   | yes      | Isolation scope                                                                            |
| `environmentId`    | string   | yes      | Co-scoped with `appId`; Exposures are per-Environment (ADR-0027)                           |
| `experimentId`     | string   | yes      | The Experiment being evaluated                                                             |
| `runId`            | string   | yes      | The Run that produced this Exposure (stamped at fire time from `EvaluateResult.liveRunId`) |
| `flagKey`          | string   | yes      | The Flag evaluated                                                                         |
| `targetingKey`     | string   | yes      | The Entity identifier                                                                      |
| `idType`           | string   | yes      | Entity type; matches Assignment Store key (guards cross-type collisions)                   |
| `variant`          | string   | yes      | The resolved Variant name                                                                  |
| `sourceId`         | string   | yes      | Edge POP identifier                                                                        |
| `exposureAt`       | ISO 8601 | yes      | Canonical encounter time; remote receive time or verified trusted server commit            |
| `serverReceivedAt` | ISO 8601 | yes      | Splitch durable-acceptance time; delivery diagnostics and retention                        |
| `clientFiredAt`    | ISO 8601 | yes      | Wall-clock at fire time; diagnostics only                                                  |

`runId` is stamped from `EvaluateResult.liveRunId` at fire time — set by the evaluate path,
not the pipeline.

`exposureAt`, `serverReceivedAt`, and `clientFiredAt` are logged. `MIN(exposureAt)` is the
canonical first-touch anchor; unverified client time is diagnostics only.
`ingestTs` is not part of the producer or durable outbox shape. Tinybird assigns physical
`ingest_ts` with `DEFAULT now64(3)` when it inserts the row.

## First-touch identity

`(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)` — six components, no Variant (the query-time pipeline tuple; canonical in [pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md)). Resolved by
`MIN(exposure_at)` at query time: many raw Exposures for the same Entity/Run share this identity and
the earliest encounter is the first-touch winner. Variant is excluded so that two Exposures with
**different** Variants for the same Entity/Run are a conflict caught by the `__multiple__`
quarantine (a separate GROUP BY step), not silently collapsed.

This is distinct from the wire-level `dedup_key` (a per-physical-row sha256 idempotency key for
at-least-once ingest); see [pipeline/exposure-event-contract.md](../pipeline/exposure-event-contract.md).

## Holdover path: no Exposure fired

If `EvaluateResult.isHoldover === true`, `sdk.evaluate()` does **not** fire an Exposure.
The holdover is already counted under `priorRunId`; a new Exposure would double-count it
across Runs. The check is inside `evaluate()` before any Exposure is queued.

## SDK seen-set (hot-path optimization only)

The SDK may keep a per-request in-memory set of `(experimentId, runId)` pairs for which
it has already fired an Exposure, to avoid redundant network writes within one request.
This is a wire-efficiency optimization only. The pipeline dedup is authoritative.
The seen-set is per-`(experiment, runId)` so a Run boundary correctly lets a fresh Exposure
fire under the new Run.

## Peek: no Exposure, no Assignment Store write

`sdk.peekVariant()` returns the same resolved Variant as `sdk.evaluate()` but fires nothing:

- No Exposure event queued.
- No Assignment Store write (pipeline does not receive anything to trigger `put()`).
- The peeked Entity is not counted in any Run's denominator.
- If peeked many times, no cumulative state is built up.

A peeked Entity who later encounters the Variant via a real page render should call
`sdk.evaluate()` at that point, which fires the Exposure then.

## Pipeline first-touch write

When `sdk.evaluate()` fires an Exposure (non-holdover path), the Exposure event travels to
Exposure-pipeline orchestration hosted by the Evaluation Worker. That orchestration calls
`AssignmentStore.put()` after durable acceptance:

1. The Evaluation Worker resolves `EvaluateResult` with `liveRunId`.
2. Event Ingest atomically seals the scoped Evaluation claim, result fingerprint, retry-stable
   Exposure row, and `raw_events` outbox payload.
3. Only after that seal does the Worker return success to the SDK.
4. The outbox publishes to Queue asynchronously, and Exposure-pipeline orchestration invokes
   `AssignmentStore.put()`, whose DO adapter calls
   `DO.putIfAbsent(key, { runId, variant })`, without waiting for the DO commit.
5. The DO commits and writes through to KV; future `getAll()` reads return the holdover record.

Step 2 is the durable analysis acceptance boundary on the response path. Queue publication, Tinybird
delivery, and the DO/KV write in steps 4-5 are asynchronous. If step 2 fails, the response is
fail-loud and no Assignment Store write begins.

## Seam boundary

**What's on this side (SDK accessor):** `evaluate()` / `peekVariant()` / `verify()` method
surface; Exposure event assembly; seen-set optimization; holdover short-circuit.

**What's NOT here:** dedup logic (pipeline), first-touch write (Exposure-pipeline orchestration via
the Assignment Store DO adapter), rule matching (evaluate policy module).

**No caller-controlled suppression:** `evaluate()` fires an Exposure for every successful fresh
assignment under a live Experiment Run. Holdovers, disabled Flags, no-Experiment, no-live-Run, and
error/default branches fire none because no new measurable assignment occurred. `peekVariant()` and
`verify()` never fire. A caller cannot accidentally skip Exposure for a successful fresh assignment
on the `evaluate()` path.

## Sources

- [../../adr/0004-exposure-fires-on-read.md](../../adr/0004-exposure-fires-on-read.md)
- [../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
- [../../adr/0037-client-side-configuration-verification-tiered-by-credential.md](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md)
- [../sdk/exposure-accessor.md](../sdk/exposure-accessor.md) — canonical public accessor surface
- [../../architecture/assignment-exposure-seam.md](../../architecture/assignment-exposure-seam.md) (decision 3, Exposure definition)
