# Event ingest contract: Evaluation Worker to raw log

Evaluation Worker instances produce Exposure events and hand them to the Event Ingest Worker for
append-only delivery to `raw_events` in Tinybird. This contract governs the delivery guarantees,
idempotency, timestamp handling, and the interaction with the Assignment Store write on apparent
first-touch.

## Delivery guarantee

**At-least-once, never exactly-once.** The same physical Exposure (one Entity, one Variant, one moment) may produce multiple rows in `raw_events` — this is intentional (ADR-0004, ADR-0010). The dedup query is authoritative; the raw log is the system of record.

Each POP emits independently. There is no global ordering requirement and no global edge dedup
store. Late-arriving events with an earlier `server_ts` than previously seen rows are handled
correctly on the next dedup query run (replayability, ADR-0010).

## SDK seen-set is not authoritative

The SDK maintains a per-`(experiment_id, run_id)` seen-set as a **hot-path optimization** to avoid redundant wire calls. This set is per-node and per-runtime; it is NOT the dedup authority. An Entity hitting two POPs produces two raw rows even if both SDK instances have seen it — that is the correct input to the ELT deduper. The seen-set is reset at Run boundaries so a new Run correctly lets a fresh Exposure fire.

## Timestamp sourcing

| Field | Source | Use |
|---|---|---|
| `server_ts` | Evaluation Worker's `Date.now()` when the Exposure fires | Canonical for `MIN(ts)` first-touch ordering in the dedup query |
| `ingest_ts` | Raw-log append / collector receive time | Snapshot/tail watermark only; never used for analysis ordering |
| `client_ts` | SDK payload from the client runtime | Diagnostics only; never used for ordering |

`server_ts` and `ingest_ts` are always populated. `client_ts` is optional — if absent,
diagnostics degrade gracefully. Never use `client_ts` for first-touch ordering (clock skew
vulnerability). Never use `ingest_ts` for first-touch ordering either; it exists only so the
physical snapshot/tail layer can safely catch late-arriving rows.

## `run_id` stamping

`run_id` is stamped at **SDK fire-time** from the live Run config the Evaluation Worker read from
KV. The Evaluation Worker does not fetch `run_id` from a separate source at ingest time. If the KV
config is stale by up to ~60s (ADR-0009 propagation window), the Exposure is stamped with the Run
the Evaluation Worker knew about. This is accepted and self-healing.

## `id_type` sourcing

`id_type` is read from the **Run config** in KV, not from the client. The Evaluation Worker injects
it. This ensures the Assignment Store DO key `(experiment_id, id_type, targeting_key_hash)` is always
consistent with the Experiment's declared Entity type. If an SDK sends a Targeting Key value of the
wrong type (e.g., workspace ID when the Run declares `id_type = 'user'`), it is a client integration
error; the Evaluation Worker still stamps the configured `id_type` and derives `targeting_key_hash`
server-side.

## `app_id` injection

`app_id` is injected by the Evaluation Worker from the authenticated credential context (Client Key
or API Key binding). Never sourced from the client payload. This is the data-isolation guarantee
(ADR-0018).

## Cross-POP duplication

Multiple POPs may fire an Exposure for the same Entity in the same Run within a short window (e.g., CDN routing change). This produces multiple `raw_events` rows with different `source_id` values and potentially slightly different `server_ts` values. The dedup query picks `MIN(server_ts)` — the earliest server-received-at row wins as first-touch. The DO's `putIfAbsent` is called by whichever POP fires the Exposure, and the first DO writer wins (ADR-0009).

**Note on experience/analysis divergence:** The DO first-touch winner (experience) and the dedup query first-touch winner (analysis) may not be the same POP if their `server_ts` values differ by milliseconds. This is accepted — the divergence is cosmetic and self-healing, bounded to the ~60s KV propagation window. Variant assignment is deterministic, so any two POPs assign the same Variant to the same `(run_id, Targeting Key)` pair (ADR-0001).

## Holdover write trigger

On apparent first-touch (the Evaluation Worker has no KV entry for this
`(experiment_id, id_type, targeting_key_hash)`), the Evaluation Worker MUST call `DO.putIfAbsent` for the
Assignment Store (ADR-0009). The sequencing:

1. Evaluate the flag → produce `(run_id, variant)` from `assign()` or KV replay.
2. Append the raw Exposure row to Tinybird (`raw_events`).
3. If no KV entry was found: call `DO.putIfAbsent(key, run_id, variant)` asynchronously (fire-and-forget with short timeout).

The DO write is **non-blocking on the hot path** — it executes with a short timeout (~100ms) and does not delay the response to the SDK caller. If the DO write times out or fails, it is retried asynchronously. A DO write failure is a holdover miss only for the KV propagation window; because `assign()` is deterministic (ADR-0001), the Entity gets the same Variant on the next evaluate even without the holdover. No distributed transaction — experience (DO) and analysis (log) each self-correct.

## Ingest failure contract

| Failure | Effect | Recovery |
|---|---|---|
| Tinybird append fails | Raw row never written; dedup never sees this Exposure | Retry at-least-once; eventual consistency; SDK can re-fire on next evaluate |
| DO write fails after Tinybird append | Holdover miss for up to ~60s + retry window | `assign()` is deterministic — same Variant computed on miss; DO retry picks up |
| KV write-through from DO fails | KV miss for ~60s | Next KV read recomputes and re-propagates via DO (self-healing) |

There is no distributed transaction across Tinybird + DO + KV. The failure modes are cosmetic and self-healing within the ~60s KV propagation window.

## Physical ingest endpoint

The Event Ingest Worker calls the Tinybird Events API (`/v0/events?name=raw_events`) via a `fetch()`
call in a non-blocking context (`ctx.waitUntil`). The request carries:

- JSON body: one Exposure row per request (or batched as newline-delimited JSON)
- Authorization: Tinybird ingest token (secret, bound to the Worker via secret binding, never client-visible)

## Non-exposing paths

Peek (`sdk.peekVariant`) and test-evaluation (ADR-0026) MUST NOT call the ingest endpoint. These are structurally separate code paths — no "suppression flag" on a shared ingest call.

## Sources

- [ADR-0004](../../adr/0004-exposure-fires-on-read.md) — expose-on-read, peek as distinct accessor
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md) — SDK seen-set is not authoritative
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md) — DO write trigger, KV propagation window, failure modes
- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md) — at-least-once, no global ordering
- [ADR-0024](../../adr/0024-physical-exposure-dedup-engine-lambda-snapshot-plus-realtime.md) — Tinybird physical ingest
