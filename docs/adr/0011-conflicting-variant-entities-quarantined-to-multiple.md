# A conflicting-Variant Entity is quarantined to `__multiple__`, not silently resolved

**Status:** accepted

When an Entity's raw Exposures show **more than one distinct Variant within a single Run**, the dedup
query buckets it into a `__multiple__` sentinel, **excludes it from all real arms**, and surfaces the rate
as a **health metric** (GrowthBook's approach; ~1% tolerated, above which it signals a real defect). We do
_not_ take the first-touch (`MIN(ts)`) Variant and move on.

The reason is splitch's own invariants. Given pure `assign()` (ADR-0001), an authoritative per-key
holdover DO (ADR-0009), and assignment-edit-opens-a-new-Run (ADR-0003), a same-Run Variant conflict can
**only** mean one of three defects:

1. a **config-propagation race** (salt/allocation mid-flight across POPs) — a bug in the delivery layer;
2. an **SDK bug / bad integration** that bypassed the holdover read;
3. a **salt/allocation change without a new Run** — a direct ADR-0003 violation (these are
   assignment-affecting edits and must open a new Run; a measurement edit cannot cause a Variant conflict).

All three are defects you want to see _loudly_. "First-touch wins" does not erase the conflict; it
**silently biases whichever arm won the timestamp**, and SRM will not reliably catch it because the
Entity still counts cleanly in one arm — a corrupted Experiment behind a green dashboard, in the seam
explicitly identified as the subtlest correctness seam in splitch.

## Considered options

- **First-touch wins (`MIN(ts)` Variant)** — rejected: simpler and keeps the Entity in an arm, but turns
  a delivery/integration defect into invisible arm bias. This is the failure mode `__multiple__` exists to
  prevent.

## Consequences

The dedup query carries one extra clause —
`CASE WHEN COUNT(DISTINCT variant) > 1 THEN '__multiple__' ELSE MAX(variant) END` — negligible cost on a
query already being written. `__multiple__` Entities are excluded from the analysis denominator everywhere
(including the SRM denominator) and watched as their own health signal; a rising rate is an alert that a
real defect (race, SDK, or ADR-0003 violation) is in play. Fail fast, fail loud.
