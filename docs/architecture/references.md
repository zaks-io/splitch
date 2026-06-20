# Reference platforms & docs

We are deliberately **not reinventing the wheel** on experimentation. splitch's experiment terms are
adopted from Statsig / Eppo / GrowthBook (per [CONTEXT.md](../../CONTEXT.md)), and the flag side from
Cloudflare Flagship + OpenFeature. This file collects the primary sources so design decisions can be
checked against established practice later.

Verified live 2026-06-20. Every decision in
[assignment-exposure-seam.md](./assignment-exposure-seam.md) is confirmed by these sources in the
vendors' own words — annotated below.

## Flag side (canonical for splitch)

- **Cloudflare Flagship — concepts**: https://developers.cloudflare.com/flagship/concepts/
  (App, Flag, Variation, Targeting Rule, Percentage Rollout, Evaluation Context). The default Provider.
- **OpenFeature — glossary**: https://openfeature.dev/specification/glossary/
  (Targeting Key, Variant, Fractional Evaluation, Provider, Client, Resolution). The SDK is
  OpenFeature-shaped; their terms win over Flagship's where they differ.
- **OpenFeature — full spec**: https://openfeature.dev/specification/

## Experiment side

### Statsig (deterministic assignment, salts)

- **How Evaluation Works**: https://docs.statsig.com/sdks/how-evaluation-works
  Confirms our **pure `assign(Run, Targeting Key)`**: "given the same user and the same state of the
  experiment, Statsig always returns the same result, even when evaluated on different platforms."
  Mechanism: SHA256(user id + per-experiment salt) → bucket out of 10000.
- **Reuse Experiment Salts**: https://www.statsig.com/updates/update/xp-salt
  Per-experiment salt = statistical independence between experiments. Relevant to how a **Run** carries
  its salt.
- **Persistent Assignment**: https://www.statsig.com/updates/update/persistentassignment
  Keeps a user bucketed even when allocation/targeting changes mid-experiment. We solve the same
  problem differently — a material edit opens a **new Run** rather than mutating in place. Worth a
  conscious compare before we build (see "Open question" below).
- **Server SDK (Go) reference**: https://docs.statsig.com/server/golangSDK/
- **Open source — server core (readable bucketing/eval code)**:
  https://github.com/statsig-io/statsig-server-core
  Org: https://github.com/statsig-io  (note: client JS uses djb2 for name obfuscation, not bucketing).

### Eppo (assignment logging, dedup, warehouse-native analysis)

- **Assignment deduplication**: https://docs.geteppo.com/sdks/sdk-features/assignment-deduplication/
  Confirms our **SDK seen-set**: "deduplicates assignment events using an internal cache... one and
  only one canonical event is transmitted," server-side LRU, tunable. Their stated reason matches ours:
  un-deduped logging bloats storage and analysis for no benefit.
- **Assignment logging**: https://docs.geteppo.com/sdks/event-logging/assignment-logging/
  The logging-callback model — SDK computes, you write the event to your warehouse. Warehouse-native,
  like our exposure-event-is-source-of-truth.
- **Diagnostics (SRM + multi-variant)**: https://docs.geteppo.com/experiment-analysis/diagnostics/
  Confirms **first-touch / one-variant-per-Entity**: "subjects seen in multiple variants will be
  removed from analysis."
- **Designing and Deploying Online Field Experiments** (academic, the canonical methods paper Eppo
  cites): https://arxiv.org/pdf/1409.3174

### GrowthBook (open source — the most readable end-to-end reference)

- **Main repo (MIT core)**: https://github.com/growthbook/growthbook
- **Stats engine source** (CUPED, Sequential, Bayesian, SRM checks):
  https://github.com/growthbook/growthbook/tree/main/packages/stats
  This is the single best place to read real experiment statistics code.
- **Understanding Experiment Results**: https://docs.growthbook.io/app/experiment-results
- **Troubleshooting / SRM**: https://docs.growthbook.io/kb/experiments/troubleshooting-experiments
  Confirms our **SRM = chi-square vs declared split**: "standard chi-squared test... compares observed
  units to expected units... p-value for the probability of this split if truly unbiased."
- **Experiment Phases**: https://docs.growthbook.io/app/experiment-configuration
  Their **Phase** ≈ our **Run** (time-boxed analysis window). Their docs warn "Be very careful using
  phases" — heed this when we design Run transitions.
- **Sticky Bucketing**: https://docs.growthbook.io/app/sticky-bucketing
  Same problem as Statsig Persistent Assignment (see open question).
- **Carryover bias** (why re-bucketing across changes is dangerous):
  https://docs.growthbook.io/kb/experiments/carryover-bias
- **Glossary**: https://docs.growthbook.io/kb/glossary

## Resolved: sticky bucketing vs. new Run (Run lifecycle grill, 2026-06-20)

All three platforms ship **Sticky Bucketing / Persistent Assignment** (keep a user in their original
Variant across a config change). splitch's answer: **both, at different layers.**

- A **material** edit opens a **new Run** → fresh, clean dataset (dataset cleanliness).
- At the Run boundary, a holdover Entity (one already *exposed* under a prior Run) keeps its prior
  Variant for **experience** but is **not re-counted** in the new Run (continuity *without*
  contaminating the new dataset).

So the platforms' sticky-bucketing store maps to our **holdover-Variant store**:
`(Experiment, Targeting Key) -> (runId, Variant)`, written at first Exposure — the one piece of durable
per-Entity state on the seam. See [assignment-exposure-seam.md](./assignment-exposure-seam.md) §
"Run lifecycle". Carryover bias is avoided on *both* axes (clean data AND no jarring experience flip).
