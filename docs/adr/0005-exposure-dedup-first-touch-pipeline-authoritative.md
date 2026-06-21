# Exposure dedup is first-touch per (Entity, Run), authoritative in the pipeline

**Status:** accepted

The analysis denominator is **unique Entities per Run, first-touch**: an Entity's _earliest_ Exposure
in a Run is the one that counts and anchors its Conversion Window; repeat reads, sessions, and edge
nodes do not add to the count. Dedup happens at two layers doing two different jobs: the **SDK seen-set**
is a hot-path/wire optimization only, and the **pipeline dedup** (`GROUP BY entity, run`, `MIN(timestamp)`)
is the authority. We do not trust the SDK set as source of truth because, across splitch's five edge
runtimes, seen-sets are per-node — the same Entity hitting two POPs produces two "first" exposures, so
only the pipeline dedup is correct.

First-touch (not any-touch) is a correctness rule: a later anchor would let post-treatment behavior bias
the Conversion Window. Session is a **Dimension**, never the denominator unit.

## Consequences

The raw Exposure stream is intentionally left un-collapsed on the wire; correctness lives in the
pipeline. Every analysis query must dedup — this trades the "forget to fire exposure" bug (killed by
ADR-0004) for a "forget to dedup in a query" risk, mitigated by centralizing dedup in shared
analysis SQL rather than per-query.
