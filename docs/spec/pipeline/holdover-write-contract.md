# Holdover write contract — pipeline → Assignment Store on first Exposure

The pipeline drives the Assignment Store write. This document specifies the trigger, timing, DO semantics, KV propagation, and failure contract. Builds on [edge-ingest-contract.md](./edge-ingest-contract.md); the Assignment Store interface is defined in the platform area spec.

## Two jobs, two authorities

| Job | Primitive | Authority |
|---|---|---|
| Experience (what the Entity sees on the next request) | Durable Object → KV | DO is truth |
| Analysis (what the denominator counts) | `raw_events` → dedup query | Raw log + dedup query is truth |

The two can momentarily disagree (the DO write guesses first-touch; the batch dedup confirms it later). That is fine — the DO governs what a returning Entity *sees*, never what analysis *counts*.

## DO key structure

```
key = (experiment_id, id_type, targeting_key)
```

- `id_type` is sourced from the Run config in KV (not from the client) — see [edge-ingest-contract.md](./edge-ingest-contract.md).
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
4. **If present with different `run_id`**: the Entity is a holdover from a prior Run. The evaluate path handles the replay decision — the DO write here is for the *new* Run's first-touch only if the new Run's `run_id` is not yet recorded. On Run boundary, a returning holdover Entity is NOT re-counted in the new Run; it keeps its prior Variant (sticky experience, ADR-0006). The DO stores only the most recent `(run_id, variant)` per key.

## Write-through to KV

After a successful `putIfAbsent`, the DO writes `(run_id, variant)` to Workers KV under the same key. All subsequent evaluate calls from any POP read KV directly (no DO hop on the hot path, ADR-0009).

KV propagation window: up to ~60s. During this window, a cross-POP evaluate may miss the holdover and recompute `assign()`. Because `assign()` is deterministic (ADR-0001), the same Variant is computed — the miss is cosmetic, not a correctness failure.

## Timing in the hot path

```
evaluate() call
  ├── Read KV for holdover (cache hit → replay, cache miss → assign())
  ├── Return Variant to SDK caller  ← response is here; not blocked by DO write
  ├── ctx.waitUntil: append raw Exposure row to Tinybird
  └── ctx.waitUntil: if KV miss → call DO.putIfAbsent(key, run_id, variant)
                        ├── DO responds within ~100ms timeout
                        ├── On success: DO write-throughs to KV
                        └── On timeout/failure: enqueue for async retry
```

The DO write is non-blocking — executed in `ctx.waitUntil` (Cloudflare's background task mechanism). The SDK caller never waits for the DO write. The Tinybird append and DO write are independent background tasks.

## Failure contract

| Failure | Effect on experience | Effect on analysis | Recovery |
|---|---|---|---|
| DO write fails (timeout or error) | Holdover miss on next cross-POP request | None — raw log append unaffected | Async retry; assign() deterministic → same Variant computed on miss |
| KV write-through fails (after DO write succeeds) | KV miss for ~60s | None | Self-healing: next evaluate hits KV miss → DO write-through retried |
| Raw log append fails (after DO write succeeds) | DO has holdover → experience correct | Exposure never in dedup → Entity not counted in analysis Run | At-least-once retry on the ingest call; SDK re-fires on next evaluate |
| Both DO write and raw log append fail | No holdover; no analysis row | None — clean miss | Both retry independently |

No distributed transaction. The failure modes are accepted as self-healing within the ~60s KV propagation window.

## Connection between ingest and DO write

Both the raw Exposure handoff and the DO write originate from the **same Evaluation Worker** that
processed the evaluate request. The Event Ingest Worker owns Tinybird delivery after that handoff.
The DO is accessed via its binding (`env.ASSIGNMENT_STORE`), which is local to the Worker runtime
(one network hop to the DO instance in the nearest location per Cloudflare's DO placement, not
necessarily the same POP).

## Holdover retention policy

The DO stores one `(run_id, variant)` per `(experiment_id, id_type, targeting_key)` key — always the most recent Run's assignment. Prior Run assignments are overwritten when the Entity first-touches a new Run.

The KV entry follows the same overwrite semantics (the DO's write-through always writes the current `(run_id, variant)`).

There is no multi-Run holdover history in the DO. The pipeline's `raw_events` log is the history; the DO is the live pointer. When an Experiment is archived or deleted, cleanup of DO/KV entries is an operational task (the control plane issues a DO delete when the Experiment is deleted). This is bounded — one DO instance per active Entity per Experiment.

## Port contract summary (seam interface)

**Boundary:** Evaluation Worker ↔ Assignment Store DO

**What each side owns:**
- Evaluation Worker: decides when to call `putIfAbsent` (on KV miss); supplies `(key, run_id, variant)`.
- DO: serializes concurrent writes; guarantees one true first-touch winner; write-throughs to KV.

**Failure contract:** DO timeout is non-blocking; retry is async; result is cosmetic miss within KV propagation window. Not a distributed transaction.

**Deletion test:** Two real adapters exist — (1) the DO-backed Assignment Store (production), (2) an in-memory map (testing/local dev). The seam passes the deletion test.

## Sources

- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md) — pipeline drives holdover put
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md) — KV read, per-key DO write, get-then-put-if-absent atomicity, ~60s propagation window
- [ADR-0006](../../adr/0006-run-boundary-sticky-experience-counted-in-old-run.md) — holdover Entity keeps prior Run's Variant
