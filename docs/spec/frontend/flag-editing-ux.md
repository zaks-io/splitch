# Flag editing UX

## Live, per-change — not staged

Flag editing is **live and per-change**. There is no staged apply cycle for Flags. You change a
Variant, edit a Targeting Rule, reorder rules, flip the kill switch — each is a confirmed write
(server 200 → refetch, per [mutation-data-flow.md](./mutation-data-flow.md)). No batching, no
client-held pending draft.

**Start** is the Experiment concept for opening/managing a Run, not a Flag concept. Editing a
Flag never creates a Run. A Flag that is not under a running Experiment has no Run at all; its
edits are plain config changes plus an audit entry.

## Baseline rollout — the one-control path to a percentage

A Flag Configuration carries a first-class **baseline rollout**: a single percentage that applies to
traffic matching **no** Targeting Rule. It is the shortest path from "flag exists" to "flag is rolled
out to 10% of users" — one control, no rule to author, no segment to define. A matched Targeting Rule
still wins outright and honours its own `percentageRollout`; the baseline only decides the fall-through
that would otherwise go straight to the Default Variant.

The control is a percentage only. **The operator never sees or sets the bucketing salt**, because the
salt _is_ the bucket assignment: reminting it on a percentage change would silently reshuffle who is
in the rollout. The server mints the salt once when the baseline is first set and keeps it through
every later change, so dragging 10% → 25% only ever _adds_ users to the treatment and never swaps
anyone out. Clearing the rollout is the one visible way to drop that cohort; re-establishing it
afterwards starts a new one.

A baseline change is a rollout **value** change, so it falls under the Environment Policy's
`targeting_rollout_value` gate — in a `confirm` environment, changing the production percentage takes
an explicit confirmation like any other rollout edit.

Because the baseline resolves against exactly two Variants (the Default, and the one Variant it rolls
_into_), it requires a Configuration whose `availableVariantNames` names exactly one non-Default
Variant. Anything else is ambiguous and fails loud rather than guessing a target (ADR-0036).

That is enforced at **write** time, not at evaluation time: a `PATCH .../config` (or a Promotion) that
would leave a non-null baseline alongside zero or two-plus non-Default available Variants is rejected
with `VALIDATION_ERROR` on `rollout`, naming the available Variants. The operator finds out at the
keystroke that caused it instead of from production traffic later. Clearing the baseline (`rollout:
null`) is always allowed, so an ambiguous Configuration is never wedged.

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
