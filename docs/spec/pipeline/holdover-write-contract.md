# Holdover write contract — pipeline → Assignment Store on first Exposure

The pipeline drives the Assignment Store write. This document specifies the trigger, timing, DO semantics, KV propagation, and failure contract. Builds on [edge-ingest-contract.md](./edge-ingest-contract.md); the Assignment Store interface is defined in the platform area spec.

## Two jobs, two authorities

| Job                                                   | Primitive                  | Authority                      |
| ----------------------------------------------------- | -------------------------- | ------------------------------ |
| Experience (what the Entity sees on the next request) | Durable Object → KV        | DO is truth                    |
| Analysis (what the denominator counts)                | `raw_events` → dedup query | Raw log + dedup query is truth |

The two can momentarily disagree (the DO write guesses first-touch; the batch dedup confirms it later). That is fine — the DO governs what a returning Entity _sees_, never what analysis _counts_.

## DO key structure

```
key = (experiment_id, id_type, targeting_key_hash)
```

- `id_type` is the request `idType` after validation against the Run config in KV — see [edge-ingest-contract.md](./edge-ingest-contract.md).
- The key uniquely identifies one Entity's slot for one Experiment across all Runs.
- One DO instance exists per unique key (fine-grained DOs, ADR-0009).

## DO value written

```
value = { run_id: string, variant: string }
```

- `variant` is the Variant name (string) assigned by `assign()` or replayed from prior state.
- `run_id` identifies which Run this holdover belongs to (so a returning Entity in Run N+1 knows its prior Run).

## `putIfAbsent` semantics

The DO executes `get → decide → put` atomically (no intervening non-storage I/O between the get and the put — a correctness rule, not re-litigable). This is the serialization guarantee:

1. **Get** the current value for this key from DO storage.
2. **If absent**: write `{ run_id, variant }` (first-touch winner).
3. **If present and same `run_id`**: no-op (Entity already has a holdover for this Run).
4. **If present with different `run_id`**: the Entity is a holdover from a prior Run. The evaluate path handles the replay decision — the DO write here is for the _new_ Run's first-touch only if the new Run's `run_id` is not yet recorded. On Run boundary, a returning holdover Entity is NOT re-counted in the new Run; it keeps its prior Variant (sticky experience, ADR-0006). The DO stores only the most recent `(run_id, variant)` per key.

## Write-through to KV

After a successful `putIfAbsent`, the DO writes `(run_id, variant)` to Workers KV under the same key. All subsequent evaluate calls from any POP read KV directly (no DO hop on the hot path, ADR-0009).

KV propagation window: up to ~60s. During this window, a cross-POP evaluate may miss the holdover and recompute `assign()`. Because `assign()` is deterministic (ADR-0001), the same Variant is computed — the miss is cosmetic, not a correctness failure.

## Timing in the hot path

Two callers drive Assignment Store writes. Timing differs:

**`evaluate` (live path):** response is not blocked on the DO/KV write.

```
evaluate() call
  ├── Read KV for holdover (cache hit → replay, cache miss → assign())
  ├── On fresh Exposure: synchronously seal retry-stable row in Event Ingest raw_events outbox
  │     └── Fail Evaluation before Assignment Store write if durable seal fails
  ├── Return Variant to SDK caller  ← response is here; not blocked by Queue, Tinybird, or DO write
  └── ctx.waitUntil: after durable seal, if KV miss → call DO.putIfAbsent(key, run_id, variant)
                        ├── DO responds within ~100ms timeout
                        ├── On success: DO write-throughs to KV (awaited inside the writer)
                        └── On timeout/failure: enqueue for async retry
```

**`POST /api/sdk/exposures` (ticket redemption):** the Worker **awaits** durable holdover-write
outbox ownership and attempts the writer inline before acknowledging the item. HTTP success for
`accepted` means ownership sealed and either KV-complete or owned for Durable Object alarm retry —
never “ack then maybe write.” Deletion cutoff returns `suppressed` instead of `accepted`.

The SDK caller of `evaluate` waits for durable Exposure ownership, not Queue publication or
Tinybird. The outbox retries Queue publication until it succeeds. On the evaluate path the DO
write remains non-blocking in `ctx.waitUntil` and starts only after the durable Exposure seal
succeeds. This ordering prevents a successful holdover write from suppressing the only retry of
an unaccepted Exposure.

## Failure contract

| Failure                                          | Effect on experience                      | Effect on analysis                         | Recovery                                                                      |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| DO write fails on evaluate `waitUntil`           | Holdover miss on next cross-POP request   | None — raw log append unaffected           | Async retry; assign() deterministic → same Variant computed on miss           |
| DO/KV write fails after exposures ownership seal | SDK may still see `accepted` once owned   | None                                       | Holdover-write outbox Durable Object alarms retry until KV-complete or poison |
| Exposures ownership seal fails                   | Item `rejected` (`SERVICE_UNAVAILABLE`)   | Exposure row may already be sealed         | SDK retries same `exposureId`                                                 |
| Exposures retries exhausted (poisoned)           | Item `rejected` (`INTERNAL_SERVER_ERROR`) | None                                       | Fail loud; no silent ack                                                      |
| Entity/App deletion cutoff                       | Item `suppressed` (not success)           | Stale Assignment Store writes stopped      | Post-`delete_before_ts` ensures remain allowed                                |
| KV write-through fails (after DO write succeeds) | KV miss for ~60s                          | None                                       | Self-healing on evaluate; exposures outbox retries until complete             |
| Durable Exposure outbox seal fails               | Evaluation fails; no holdover is written  | No accepted Exposure                       | Retry the same Evaluation idempotency key                                     |
| Queue publication fails after outbox seal        | Experience unaffected                     | Analysis availability is delayed           | Durable outbox retries Queue publication                                      |
| Tinybird `429`/`500`/`503` after queue handoff   | Experience unaffected                     | Analysis availability is delayed           | Bounded queue retry with the same row and stable dedup key                    |
| Tinybird `422` after queue handoff               | Experience unaffected                     | Raw/derived commit is indeterminate        | Durable scoped reconciliation; no ordinary retry                              |
| Permanent Tinybird failure or quarantine         | Experience unaffected                     | Analysis unavailable until operator repair | Durable DLQ transfer, alert, and manual replay only                           |

There is no distributed transaction across Tinybird and Assignment Store. Evaluate-path DO/KV
propagation failures self-heal within the ~60s window or via outbox retry. Exposures-ticket
acks require ownership first. Tinybird retry, reconciliation, and DLQ states are visible
operational failures and are not described as self-healing.

## Connection between ingest and DO write

**`evaluate`:** the Evaluation Worker seals the Exposure in the Event Ingest raw_events outbox,
returns the Variant, then drives Assignment Store via `ctx.waitUntil` → Assignment Store Writer DO
(`env.ASSIGNMENT_STORE_WRITER`) → `putIfAbsent` + awaited KV write-through. Event Ingest owns
Tinybird delivery after the handoff. The writer DO is one network hop away (Cloudflare placement),
not necessarily the same POP.

**`POST /api/sdk/exposures`:** after the Exposure seal and claim acknowledge path, the Evaluation
Worker **awaits** the holdover-write outbox Durable Object (`env.HOLDOVER_WRITE_OUTBOX`, one DO per
Entity slot). That outbox seals durable ownership, attempts the Assignment Store Writer inline
(`putHashed` → writer DO → KV), and on failure schedules DO alarm retries without a later Evaluation
re-run. Ownership (or KV-complete) is required before an `accepted`/`deduplicated` ack; deletion
cutoff returns `suppressed`. App deletion enumerates Entity outboxes via
`env.HOLDOVER_WRITE_APP_INVENTORY` (strongly consistent), not Assignment Store KV list.

## Holdover retention policy

The DO stores one `(run_id, variant)` per `(experiment_id, id_type, targeting_key_hash)` key — always the most recent Run's assignment. Prior Run assignments are overwritten when the Entity first-touches a new Run.

The KV entry follows the same overwrite semantics (the DO's write-through always writes the current `(run_id, variant)`).

There is no multi-Run holdover history in the DO. The pipeline's `raw_events` log is the history; the DO is the live pointer. When an Experiment is archived or deleted, cleanup of DO/KV entries is an operational task (the control plane issues a DO delete when the Experiment is deleted). This is bounded — one DO instance per active Entity per Experiment.

## Port contract summary (seam interface)

**Boundary:** Evaluation Worker ↔ Assignment Store DO

**What each side owns:**

- Exposure-pipeline orchestration hosted by the Evaluation Worker: after durable Exposure acceptance,
  decides when to call `AssignmentStore.put()` (on KV miss) and supplies `(key, run_id, variant)`.
- DO: serializes concurrent writes; guarantees one true first-touch winner; write-throughs to KV.

**Failure contract:** On `evaluate`, DO timeout in `waitUntil` is non-blocking (async retry; cosmetic miss within the KV window). On exposures redemption, ownership seal or inline writer failure rejects the item (SDK retains the queue); after ownership, alarm retry continues without re-evaluation until KV-complete or poison. Not a distributed transaction.

**Deletion test:** Two real adapters exist — (1) the DO-backed Assignment Store (production), (2) an in-memory map (testing/local dev). The seam passes the deletion test.

## Sources

- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md) — pipeline drives holdover put
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md) — KV read, per-key DO write, get-then-put-if-absent atomicity, ~60s propagation window
- [ADR-0006](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md) — holdover Entity keeps prior Run's Variant
- [ADR-0043](../../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md) — pending queue-backed Tinybird delivery refactor
