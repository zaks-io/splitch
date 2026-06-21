# Flag editing UX

## Live, per-change — not staged

Flag editing is **live and per-change**. There is no staged apply cycle for Flags. You change a
Variant, edit a Targeting Rule, reorder rules, flip the kill switch — each is a confirmed write
(server 200 → refetch, per [mutation-data-flow.md](./mutation-data-flow.md)). No batching, no
client-held pending draft.

**Start** is the Experiment concept for opening/managing a Run, not a Flag concept. Editing a
Flag never creates a Run. A Flag that is not under a running Experiment has no Run at all; its
edits are plain config changes plus an audit entry.

## Production-change confirmation (intended, future)

A production-affecting change must be **intentional**. Before a flag edit commits to production it
passes through a **confirmation step** — a guard against fat-fingering a rule and breaking prod.
This is not a draft (the edit is still live and per-change once confirmed); it is an intentionality
gate on the commit.

This gate is a **general control-plane concern**, not flag-specific — it will also cover
experiment launches and other production-affecting actions. Treated as a cross-cutting confirm
layer, designed once.

**Open dependency — what is "production"?** With no environment split, *every* flag edit is a
production change, so the gate would fire on every write (possibly noisy). Scoping it cleanly
likely needs a dev/staging/prod environment concept, which splitch does **not** currently have
(not in the glossary). Resolve the environment question before finalizing when the confirm fires.

## A Flag under a running Experiment

### The Run is the snapshot

When an Experiment starts, the assignment config (salt, allocation, Variant set, Targeting,
Targeting Key) is **frozen into the Run** (ADR-0002). This frozen config **is** the snapshot — no
separate copy mechanism is needed. The experiment evaluates against the Run's frozen config, never
the live Flag. Editing the live Flag therefore **cannot** change what an exposed Entity sees; the
experiment is isolated by construction.

### Controlled fields are read-only while a Run is live (option 3c)

While an Experiment controls a Flag, the experiment-controlled fields (Variant set and the
Targeting the Experiment owns) are **read-only in the UI**, with a banner: *"Controlled by
Experiment X."* The banner links to the owning Experiment. To change those fields you must end the
Experiment.

Chosen over the alternatives because it is the easiest to reason about: one owner at a time, no
silent divergence (3a) and no two-sources-of-truth drift (3b).

### Kill switch is always exempt

The enable/disable kill switch is **never** locked, even while an Experiment runs. An operator must
always be able to turn a flag off in an incident. Killing an experiment-controlled flag is a loud,
logged event; its effect on the running Run (end / invalidate) is designed in the experiment
lifecycle spec.
