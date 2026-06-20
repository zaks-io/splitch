# Assignment edits open a new Run; measurement edits recompute over the existing Run

**Status:** accepted (supersedes the original "measurement edits open a new Run" decision, 2026-06-20)

A config edit is sorted by **what it invalidates**, and the two cases get different treatment:

- **Assignment-affecting edits** — salt, allocation, Variant set, Targeting, Targeting Key — change
  `assign()`, so Exposures collected before and after are bucketed differently and are **not comparable**.
  These **end the current Run and open the next** (sample resets to zero). This is the ADR-0002 invariant:
  a Run is a window over which *bucketing* was frozen.
- **Measurement edits** — Metric definitions, Conversion Window, Guardrail/Activation config — change *what
  the numbers mean*, but not *who is in which arm*. The raw Exposure/event log is untouched and still
  comparable. These **recompute losslessly over the existing Run**: re-run the analysis query with the new
  definition over the same raw log. **No new Run, no sample reset.**
- **Non-material edits** (description, owner, tags, dashboard layout) apply in place.

This is what the reference platforms do, and we follow it deliberately. All three decouple metric
definitions from collected data and recompute: **Eppo** backfills a changed/added metric "from the start of
the experiment"; **Statsig** calls a measurement-definition change a *metric refresh* (recompute), reserving
*restart* for re-rolling the salt; **GrowthBook** Phases window only dates *because* metrics are decoupled
and reprocessed, not as a limitation. The earlier splitch rule (freeze measurement into the Run too) had
this backwards — it treated GrowthBook's dates-only Phase as a weakness we improved on, when it is the
deliberate result of the recompute design.

The recompute is **nearly free here, by construction**: ADR-0010 already made the raw Exposure/activation
log the append-only system of record and first-touch dedup a re-runnable windowed query. Recomputing a Metric
or Conversion-Window edit is exactly that query with a new definition — the replayability ADR-0010 was built
for. Freezing measurement would have paid a large statistical cost (nuked sample / reset time-to-significance
on every metric typo-fix or window extension) to avoid a recompute the architecture already does for free.

## Considered options

- **Freeze measurement into the Run too** (the original decision) — rejected on reconsideration: it inverts
  the industry pattern and pays a real sample-loss cost to enforce an immutability the recompute design gives
  for free. The one legitimate motive for freezing measurement is **pre-registration discipline** ("the
  analysis you registered is the analysis you got," anti-p-hacking). That is a real stance, but it is a
  *discipline tradeoff*, not a correctness win, and it belongs as an **opt-in "locked analysis" mode on an
  experiment**, never as the global default that taxes every honest measurement fix. (Deferred; not in v1.)
- **One flat "material edit" rule** (any edit opens a Run) — rejected: simpler to state but conflates two
  genuinely different axes (bucketing vs measurement) and resets the sample on edits that don't need it.

## Consequences

A Metric or Conversion-Window tweak mid-experiment **keeps the accumulated sample** and just reprocesses —
matching Eppo/Statsig/GrowthBook. An assignment edit still costs the sample (correctly: the data is no longer
comparable), and the UI must warn loudly before one. The Run's guarantee narrows honestly to **"bucketing was
frozen for this Run's life"** (ADR-0002) — measurement is reproducible over the frozen bucketing, which is all
analyzability requires. A future **pre-registration / locked-analysis** mode can re-freeze measurement per
experiment for teams that want it; that is an additive opt-in, not a change to this default.
