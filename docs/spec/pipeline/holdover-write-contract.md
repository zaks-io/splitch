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
slot = (app_id, id_type, targeting_key_hash, experiment_id)
writer_do_name = app_id + ":" + id_type + ":" + targeting_key_hash
```

- `id_type` is the request `idType` after validation against the Run config in KV — see [edge-ingest-contract.md](./edge-ingest-contract.md).
- The key uniquely identifies one Entity's slot for one Experiment across all Runs.
- One writer DO exists per App/Entity identity, with Experiment-keyed entries inside it.
  `assignmentWriterName` in contracts defines the physical name; this serialization prevents
  different Experiments from racing on the same Entity-level KV blob.

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
4. **If present with different `run_id`**: preserve and return the existing Assignment. The writer
   does not inspect Run identity to decide whether the key exists. The evaluate path replays the
   prior Variant without counting a new Exposure (ADR-0006).

## Write-through to KV

After a successful `putIfAbsent`, the DO writes `(run_id, variant)` to the Entity-level Workers KV blob under its Experiment entry. All subsequent evaluate calls from any POP read KV directly (no DO hop on the hot path, ADR-0009).

KV propagation window: up to ~60s. During this window, a cross-POP evaluate may miss the holdover and recompute `assign()`. For a new Entity, `assign()` is deterministic (ADR-0001), so the same Variant is computed and the miss is cosmetic. For an Entity held over across a Run boundary, the miss resolves under the new Run and seals a new-Run Exposure before `put` reports the earlier winner, so the Entity can count in both Runs (ADR-0064, SPL-812).

## Timing in the hot path

Two callers drive Assignment Store writes. Timing differs:

**`evaluate` (live path):** response waits for the required DO/KV Assignment commit and final
validation of the captured App identity generation.

```
evaluate() call
  ├── Read KV for holdover (cache hit → replay, cache miss → assign())
  ├── On fresh Exposure: synchronously seal retry-stable row in Event Ingest raw_events outbox
  │     └── Fail Evaluation before Assignment Store write if durable seal fails
  ├── After durable seal, if KV miss → call App Assignment authority → writer DO → KV
  │     ├── App authority fences the captured identity generation and inventories the writer
  │     ├── Writer rejects stale work at the Entity deletion cutoff
  │     └── KV write-through and final identity-generation validation are awaited
  └── Return Variant to SDK caller only after the required Assignment commit succeeds
```

**`POST /api/sdk/exposures` (ticket redemption):** the Worker **awaits** durable holdover-write
outbox ownership and attempts the writer inline before acknowledging the item. HTTP success for
`accepted` means ownership sealed and either KV-complete or owned for Durable Object alarm retry —
never “ack then maybe write.” Deletion cutoff returns `suppressed` instead of `accepted`.

The SDK caller of `evaluate` waits for durable Exposure ownership, not Queue publication or
Tinybird. The outbox retries Queue publication until it succeeds. On the evaluate path the
Assignment Store write starts only after the durable Exposure seal succeeds and is fail-closed for
the Evaluation response. Evaluate does **not** enqueue a separate durable holdover-write retry;
the application may retry the Evaluation with the same explicit key when the required commit fails.
Exposures-ticket redemption is the
path that seals holdover-write outbox ownership and schedules DO alarm retries. This ordering
prevents a successful holdover write from suppressing the only retry of an unaccepted Exposure.

## Failure contract

| Failure                                          | Effect on experience                      | Effect on analysis                         | Recovery                                                                      |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| DO/KV write fails on evaluate                    | Evaluation fails before success           | Durable Exposure remains retry-stable      | Application retries with the same explicit Evaluation idempotency key         |
| DO/KV write fails after exposures ownership seal | SDK may still see `accepted` once owned   | None                                       | Holdover-write outbox Durable Object alarms retry until KV-complete or poison |
| Exposures ownership seal fails                   | Item `rejected` (`SERVICE_UNAVAILABLE`)   | Exposure row may already be sealed         | SDK retries same `exposureId`                                                 |
| Exposures retries exhausted (poisoned)           | Item `rejected` (`INTERNAL_SERVER_ERROR`) | None                                       | Fail loud; no silent ack                                                      |
| Entity/App deletion cutoff                       | Item `suppressed` (not success)           | Stale Assignment Store writes stopped      | Post-`delete_before_ts` ensures remain allowed                                |
| KV write-through fails (after DO write succeeds) | KV miss for ~60s                          | None                                       | Self-healing on evaluate; exposures outbox retries until complete             |
| Durable Exposure outbox seal fails               | Evaluation fails; no holdover is written  | No accepted Exposure                       | Application retries with the same explicit Evaluation idempotency key         |
| Queue publication fails after outbox seal        | Experience unaffected                     | Analysis availability is delayed           | Durable outbox retries Queue publication                                      |
| Tinybird `429`/`500`/`503` after queue handoff   | Experience unaffected                     | Analysis availability is delayed           | Bounded queue retry with the same row and stable dedup key                    |
| Tinybird `422` after queue handoff               | Experience unaffected                     | Raw/derived commit is indeterminate        | Durable scoped reconciliation; no ordinary retry                              |
| Permanent Tinybird failure or quarantine         | Experience unaffected                     | Analysis unavailable until operator repair | Durable DLQ transfer, alert, and manual replay only                           |

There is no distributed transaction across Tinybird and Assignment Store. Evaluate-path DO/KV
propagation failures fail the Evaluation. An application retry uses the same explicit idempotency key.
Durable holdover-write alarm retry applies to exposures-ticket redemption, not to `evaluate`.
Exposures-ticket acks require ownership first. Tinybird retry,
reconciliation, and DLQ states are visible operational failures and are not described as
self-healing.

## Connection between ingest and DO write

**`evaluate`:** the Evaluation Worker seals the Exposure in the Event Ingest raw_events outbox,
then drives Assignment Store through the App-scoped serialized inventory authority → Assignment
Store Writer DO (`env.ASSIGNMENT_STORE_WRITER`) → `putIfAbsent` + awaited KV write-through. It
returns the Variant only after that commit and final identity-generation validation. Event Ingest
owns Tinybird delivery after the handoff. The writer DO is one network hop away (Cloudflare
placement), not necessarily the same POP.

**`POST /api/sdk/exposures`:** after the Exposure seal and claim acknowledge path, the Evaluation
Worker **awaits** the holdover-write outbox Durable Object (`env.HOLDOVER_WRITE_OUTBOX`, one DO per
Entity slot). That outbox seals durable ownership, attempts the Assignment Store Writer inline
(`putHashed` → writer DO → KV), and on failure schedules DO alarm retries without a later Evaluation
re-run. Ownership (or KV-complete) is required before an `accepted`/`deduplicated` ack; deletion
cutoff returns `suppressed`. App deletion enumerates Entity outboxes via
`env.HOLDOVER_WRITE_APP_INVENTORY` (strongly consistent), not Assignment Store KV list.
App deletion is a durable App-scoped saga outside the D1 App row: prepare/freeze
(suppress without purge), cancel restore while still pre-D1, then finalize (drain/purge +
complete). A no-foreign-key D1 deletion record crosses its irreversible boundary in the same
batch that deletes the App. Public DELETE retries authenticate against that surviving record and
resume pending finalize; an ambiguous successful D1 response never enters cancellation.

## Holdover retention policy

The DO retains the first stored `(run_id, variant)` per logical Experiment/Entity slot until
explicit cleanup. Starting a new Run never overwrites an existing Assignment.

The KV write-through publishes that retained first Assignment, including when a later put carries
a different Run or Variant.

There is no multi-Run holdover history in the DO. The pipeline's `raw_events` log is the history; the DO is the live pointer. When an Experiment is archived or deleted, cleanup of DO/KV entries is an operational task (the control plane issues a DO delete when the Experiment is deleted). This is bounded by one writer DO per active App/Entity identity.

## Port contract summary (seam interface)

**Boundary:** Evaluation Worker ↔ Assignment Store DO

**What each side owns:**

- Exposure-pipeline orchestration hosted by the Evaluation Worker: after durable Exposure acceptance,
  decides when to call `AssignmentStore.put()` (on KV miss) and supplies `(key, run_id, variant)`.
- DO: serializes concurrent writes; guarantees one true first-touch winner; write-throughs to KV.

**Failure contract:** On `evaluate`, DO/KV failure fails the request before a Variant response. On
exposures redemption, ownership seal failure rejects the item (SDK retains the queue); after ownership is
sealed, an inline writer failure may still return `owned` so the item can be acknowledged while DO
alarm retry continues without re-evaluation until KV-complete or poison. Not a distributed
transaction.

**Deletion test:** Two real adapters exist — (1) the DO-backed Assignment Store (production), (2) an in-memory map (testing/local dev). The seam passes the deletion test.

## Sources

- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md) — pipeline drives holdover put
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md) — KV read, get-then-put-if-absent atomicity, ~60s propagation window
- [ADR-0064](../../adr/0064-assignment-store-is-app-scoped-with-one-writer-per-entity.md) — App-scoped interface, one writer per Entity, Run-boundary window caveat (SPL-812)
- [ADR-0006](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md) — holdover Entity keeps prior Run's Variant
- [ADR-0043](../../adr/0043-event-ingest-will-use-durable-queue-backed-tinybird-microbatches.md) — queue-backed Tinybird delivery and recovery contract
