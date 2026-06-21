# SDK invariants across five Cloudflare edge runtimes

One App is shared by all five runtimes of one product. The SDK contract must hold across all
of them. This file pins the runtime-specific invariants and the consistency properties each
caller must accept.

## The five runtimes

An App's five runtimes (CONTEXT.md):

| Runtime | Role | SDK usage |
|---------|------|-----------|
| HTTP Workers | Request handlers, API endpoints | Primary evaluate path; fires Exposures |
| Durable Objects | Stateful long-lived objects | Can call evaluate; fires Exposures |
| Analytics Engine | Event telemetry | Flag-gated metric collection |
| Workers KV (read path) | Config / holdover reads | Read-only; no evaluate calls |
| Tinybird | Exposure + metric store | Receives raw Exposure rows; no SDK calls |

All five runtimes that call the SDK use the same App, the same Client Key (or API Key for
server Workers), and the same flag config. Flags are defined once and consumed everywhere.

## Consistency properties

### Flag config propagation: ~60s window (ADR-0009)

Flag config is cached in Workers KV with up to ~60s propagation delay. A Publish that
changes assignment config (opens a new Run) may not be visible at all POPs simultaneously.
During this window:
- Some Workers evaluate with Run N config, others with Run N+1 config.
- Exposures are stamped with the `run_id` the Worker resolved — whichever Run was live in
  its KV cache at evaluation time.
- The pipeline dedup handles mixed-Run Exposures correctly (they are separate rows; there
  is no cross-Run contamination because `run_id` is a dedup dimension).

This window is **accepted and self-healing** (ADR-0009, ADR-0009). No SDK-level
mitigation is required or possible.

### Assignment Store propagation: ~60s window (ADR-0009)

Holdover entries written by the DO propagate to KV in ~60s. A returning Entity evaluated
at a POP that hasn't received the KV write yet will compute `assign()` instead of replaying
the holdover. Because `assign()` is deterministic (ADR-0001), the computed Variant is
identical to the holdover Variant — the experience is consistent. The analysis impact is
at most a duplicate raw Exposure (the pipeline dedup collapses it).

### Cross-POP dedup: pipeline is authoritative

Each POP maintains its own per-instance seen-set (see [seen-set.md](./seen-set.md)). The
same Entity evaluated at two POPs in the same request window will fire two raw Exposures
(the respective seen-sets have no shared state). The pipeline dedup (`MIN(server_ts)` per
`(app_id, experiment_id, run_id, id_type, targeting_key)`) collapses them to first-touch.
This is the documented design (ADR-0005): cross-POP seen-sets cannot be the authority.

### No global ordering required

Exposure rows from five POPs arrive at Tinybird without a global ordering guarantee.
The dedup query operates on wall-clock `server_ts` (server-received-at timestamp, not
client-fired), which is monotonic per POP and good enough for first-touch semantics.
Clock skew between POPs is small relative to typical Conversion Windows.

## `assign()` is pure and deterministic

The hash function underlying `assign(run, targetingKey)` is deterministic — the same
`(run.salt, targetingKey)` always produces the same bucket, regardless of POP, Worker
instance, or clock. This is a correctness requirement for the five-runtime model:

- A stale KV miss falls through to `assign()` and computes the same Variant the holdover
  would have replayed.
- Any POP evaluating the same flag for the same Entity in the same Run gets the same Variant.
- Config propagation delays cause temporary inconsistency at Run boundaries, not permanent
  inconsistency within a Run.

## Credential usage by runtime

| Runtime | Credential |
|---------|-----------|
| Browser/mobile client | Client Key (public, safe to embed) |
| Server Workers (customer's backend) | API Key (secret, never client-side) |
| Durable Objects (trusted) | API Key |
| Analytics Engine | Not applicable (no evaluate; writes events) |
| Control-plane Workers | Control-plane token (ADR-0022), not SDK credentials |

## Sources

- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [ADR-0010](../../adr/0010-exposure-pipeline-is-a-raw-append-only-log-deduped-at-query-time.md)
- [ADR-0001](../../adr/0001-assignment-is-pure-not-an-event.md)
- [ADR-0005](../../adr/0005-exposure-dedup-first-touch-pipeline-authoritative.md)
