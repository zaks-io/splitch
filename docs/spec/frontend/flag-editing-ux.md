# Flag editing UX

## Live, per-change — not staged

Flag editing is **live and per-change**. There is no staged apply cycle for Flags. You change a
Variant, edit a Targeting Rule, reorder rules, flip the kill switch — each is a confirmed write
(server 200 → refetch, per [mutation-data-flow.md](./mutation-data-flow.md)). No batching, no
client-held pending draft.

**Start** is the Experiment concept for opening/managing a Run, not a Flag concept. Editing a
Flag never creates a Run. A Flag that is not under a running Experiment has no Run at all; its
edits are plain config changes plus an audit entry.

## Production-change confirmation (resolved)

A production-affecting flag edit must be **intentional**, and that gate is **not flag-specific** — it
is the cross-cutting **Environment Policy** + **Approval Request** workflow, designed once and shared
by Promotions, Variant/value changes, and Starting a Run. See
[screen-inventory.md](./screen-inventory.md#promotion--the-prod-change-approval-workflow) for the
full workflow and [ADR-0029](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md).

**"What is production?" — resolved.** Production is an **Environment** (ADR-0027), and "careful" is
that Environment's **Policy** (per-change-type `allow | confirm | approve`), not a global hardcoded
check. The gate fires only on the change types the env's Policy gates, so it is not noisy-by-default.
A gated edit becomes an **Approval Request** (diff + Review); under `confirm` the editor self-reviews
in one step, and the same object grows into second-person `approve` later without a rewrite.

## A Flag under a running Experiment

### The Run is the snapshot

When an Experiment starts, the assignment config (salt, allocation, Variant set, Targeting,
Targeting Key) is **frozen into the Run** (ADR-0002). This frozen config **is** the snapshot — no
separate copy mechanism is needed. The experiment evaluates against the Run's frozen config, never
the live Flag. Editing the live Flag therefore **cannot** change what an exposed Entity sees; the
experiment is isolated by construction.

### Controlled fields are read-only while a Run is live (option 3c)

While an Experiment controls a Flag, the experiment-controlled fields (Variant set and the
Targeting the Experiment owns) are **read-only in the UI**, with a banner: _"Controlled by
Experiment X."_ The banner links to the owning Experiment. To change those fields you must end the
Experiment.

Chosen over the alternatives because it is the easiest to reason about: one owner at a time, no
silent divergence (3a) and no two-sources-of-truth drift (3b).

### Kill switch is always exempt

The enable/disable kill switch is **never** locked, even while an Experiment runs. An operator must
always be able to turn a flag off in an incident. Killing an experiment-controlled flag is a loud,
logged event; its effect on the running Run (end / invalidate) is designed in the experiment
lifecycle spec.
