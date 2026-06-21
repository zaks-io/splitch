# Variant conflict detection and __multiple__ quarantine

## Conflict definition

An Entity showing **more than one distinct Variant within a single Run** is a conflict.

The dedup query detects this at analysis time — not at ingest, not at SDK fire-time. The evaluate path and Exposure fire logic remain simple (fire, don't judge). Detection happens in the pipeline.

## Root causes (exhaustive given splitch's invariants)

Given:
- Pure deterministic `assign()` (ADR-0001)
- Authoritative per-key holdover DO with atomic put-if-absent (ADR-0009)
- Assignment-affecting edits open a new Run (ADR-0003)

A same-Run Variant conflict can **only** be one of three defects:

| Defect | Description |
|---|---|
| Config-propagation race | Salt or allocation is mid-flight across POPs; one POP hashes with old config, another with new. The new Run should have been opened before any POP saw the config change. |
| SDK bug or bad integration | The evaluate path bypassed the holdover read, allowing a second assignment under the same Run. |
| ADR-0003 violation | Salt or allocation changed without opening a new Run. A measurement edit cannot cause a Variant conflict; only an assignment-affecting edit can, and that must open a new Run by contract. |

All three are defects. None are expected concurrency or normal operation. `__multiple__` exists to surface them, not to gracefully absorb them.

## Quarantine action

When `COUNT(DISTINCT variant) > 1` for `(app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash)`:

1. The Entity's `assigned_variant` is set to `__multiple__` (sentinel string, not a real Variant name)
2. Excluded from all real arms
3. Excluded from SRM denominator
4. Excluded from Conversion Window population
5. Excluded from all Metric aggregations

The `__multiple__` rate is surfaced as a **health metric** per Run:
- ~1% tolerated (cosmetic config-race noise at very high traffic)
- Above 1%: alert that a real defect (race, SDK, or ADR-0003 violation) is in play

## Why not first-touch-wins

First-touch-wins (`MIN(server_ts)` Variant) would:
1. Silently bias whichever arm won the timestamp race
2. Not be detected by SRM — the Entity still counts cleanly in one arm
3. Produce a corrupted Experiment behind a green dashboard

This is the specific failure mode the fail-loud principle (ADR-0011) exists to prevent. "Silently bias one arm" is worse than "lose one Entity from analysis."

## Relationship to __multiple__ and analysis

`__multiple__` is excluded everywhere the same way real Variants are included:

```
analysis population = deduped_exposures WHERE assigned_variant != '__multiple__'
SRM denominator     = COUNT(analysis population) grouped by assigned_variant
Metric aggregation  = over analysis population
activated analysis  = filter on activated Entities within analysis population
```

The `__multiple__` rate is the only thing computed *on* the quarantined Entities.

## Sources

- [ADR-0011](../../adr/0011-conflicting-variant-entities-quarantined-to-multiple.md)
- [ADR-0001](../../adr/0001-assignment-is-pure-not-an-event.md)
- [ADR-0003](../../adr/0003-material-edits-including-measurement-open-a-new-run.md)
- [ADR-0009](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
