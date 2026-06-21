# The Exposure pipeline is a raw append-only log, deduped at query time (ELT)

**Status:** accepted

The Exposure pipeline is **ELT, not ETL**: every edge runtime appends raw Exposure events to an
append-only log that is the system of record; first-touch dedup is a **windowed query run at analysis
time**, not a collapse at ingest. Delivery is **at-least-once with an idempotent dedup key**; we never
chase exactly-once streaming. This ratifies ADR-0004 (fire-on-read → intentionally redundant stream) and
ADR-0005 (pipeline-authoritative first-touch dedup) at the physical layer.

The canonical first-touch query is the standard windowed dedup —
`QUALIFY ROW_NUMBER() OVER (PARTITION BY entity, run ORDER BY ts) = 1`, equivalently `GROUP BY entity, run`

- `MIN(ts)` — re-runnable over the complete raw log whenever rules change.

This is the unanimous warehouse-native pattern (Eppo, GrowthBook, Statsig Warehouse Native), and the
edge-origin shape makes it not just idiomatic but the only sane choice: five POPs give no global ordering
and at-least-once delivery, which is exactly where "collapse early" is hardest (it needs a global edge
dedup store) and "append raw, dedup in query" is easiest (each POP just appends; the deduper sees
everything and picks `MIN(ts)` per `(entity, run)`). The redundancy ADR-0004 already chose is the correct
_input_ to an ELT deduper, not a problem to fix upstream.

## Considered options

- **Streaming dedup at ingest (ETL, collapse early)** — rejected: lossy and not replayable (a bad collapse
  is permanent), awkward with late-arriving earlier-timestamp events, and needs a stateful global edge
  dedup store the edge topology fights. Even Statsig, the one platform that dedups early, does so only as a
  best-effort _cost_ optimization over a raw store that remains the source of truth — never as the
  authority.
- **Exactly-once delivery** — rejected: "one of the hardest problems in distributed systems," and
  unnecessary. At-least-once + idempotent dedup key is the settled industry answer (Kafka, Snowplow,
  Segment, BigQuery streaming all dedup downstream by key, earliest-timestamp wins).

## Consequences

We keep both raw and transformed data (higher storage + query compute) — accepted, because raw-as-truth
buys replayability: re-run the transform when a rule changes, recover from a bad transform, incorporate
late events on the next query. A best-effort early dedup (edge cache / hash check) MAY be added later
_purely_ to cut volume if it ever hurts — explicitly non-authoritative — but it is speculative complexity
until volume demands it, so it is deferred. Every analysis query reads through the shared dedup
(see ADR-0005's centralization point); the windowed query is where first-touch, the `__multiple__`
quarantine (ADR-0011), the SRM denominator, and the Conversion Window anchor all live, as one definition.
