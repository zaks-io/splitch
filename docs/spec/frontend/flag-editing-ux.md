# Flag editing UX

## Live, per-change — not staged

Flag editing is **live and per-change**. There is no client-held staged apply cycle for Flags. Under
`allow`, a validated edit applies immediately. Under `confirm`, submit creates the durable Approval
Request and the proposer performs `approve_and_apply` in the same user action. Future `approve`
leaves that request `pending` until a distinct authorized principal performs the identical Review.
No batching and no client-held pending draft.

An applied edit returns server success and refetches per
[mutation-data-flow.md](./mutation-data-flow.md). A pending, declined, stale, or failed Review renders
the Approval Request state and never optimistically updates the Flag Configuration.

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
`targeting_rollout_value` gate — in a `confirm` Environment, changing the baseline rollout percentage
takes an explicit confirmation like any other rollout edit.

Because the baseline resolves against exactly two Variants (the Default, and the one Variant it rolls
_into_), it requires exactly one non-Default candidate. Anything else is ambiguous and fails loud
rather than guessing a target (ADR-0036).

Candidates come from `availableVariantNames`, except when that set is **empty** — an empty set means
the Configuration was never narrowed (it is initialized empty), not that zero Variants are servable,
so candidates fall back to the Flag's Variant catalog. That is what lets the one-call rollout work on
a freshly created Flag. The write gate and the evaluator apply this identically; if they disagreed, an
accepted write would fail at evaluation time instead.

That is enforced at **write** time, not at evaluation time, and against the state the write **lands**
rather than the fields the caller happened to touch. A Configuration can be stranded from either side:
setting a baseline under an available set that leaves two-plus candidates, or widening the available
set out from under an existing baseline until it does. The test is the resulting candidate count, not
the direction of the edit — widening that still leaves exactly one non-Default candidate stays valid.
Ambiguous results are rejected with `VALIDATION_ERROR` on `rollout`, naming the available Variants, so
the operator finds out at the keystroke that caused it instead of from production traffic later.

Clearing the baseline (`rollout: null`) is always allowed, and widening availability in the same write
that clears the baseline succeeds, so an ambiguous Configuration is never wedged.

## Policy-gated change Review (resolved)

A Policy-gated flag edit must be **intentional**, and that gate is **not flag-specific**. It is the
cross-cutting **Environment Policy** + **Approval Request** workflow, designed once and shared
by Promotions, Variant/value changes, and Starting a Run. See
[screen-inventory.md](./screen-inventory.md#promotion--the-policy-gated-approval-workflow) for the
full workflow and [ADR-0029](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md).

**"What is production?" — resolved.** Production is an **Environment** (ADR-0027), and "careful" is
that Environment's **Policy** (per-change-type `allow | confirm | approve`), not a global hardcoded
check. The gate fires only on the change types the env's Policy gates, so it is not noisy-by-default.
A gated edit becomes an **Approval Request** (diff + Review); under `confirm` the editor self-reviews
in one step, and the same object grows into second-person `approve` later without a rewrite.

The only positive Review action is `approve_and_apply`. Review authorization and target-version
validation happen before mutation. A changed target becomes terminal `stale`; application failure
leaves the request `pending` and shows its machine-stable error. There is no approve-only or deferred
application state.

## A Flag under a running Experiment

### The Run is the snapshot

When an Experiment starts, the assignment config (salt, allocation, Variant set, Targeting,
Targeting Key) is **frozen into the Run** (ADR-0002). This frozen config **is** the snapshot — no
separate copy mechanism is needed. The experiment evaluates against the Run's frozen config, never
the live Flag. Editing the live Flag therefore **cannot** change what an exposed Entity sees; the
experiment is isolated by construction.

### Controlled fields are refused by the Worker while a Run is live

While a running Experiment owns a Flag in an Environment, the **Worker refuses** writes to the fields
that Run owns: `availableVariantNames`, the baseline `rollout`, and this Environment's Targeting
Rules. Both `PATCH .../config` and `PUT .../targeting-rules` answer `RUN_FROZEN` (409) naming the Run
and recommending `END_RUNNING_RUN_FIRST`. The refusal is checked ahead of the Environment Policy gate,
so the change never becomes a pending Approval Request. To change those fields you must end the Run.

The panel renders that enforced refusal, it does not invent it: the controls are **absent** (not
disabled) with a banner _"Controlled by Experiment X"_ linking to the owning Experiment, and a forced
write surfaces the Worker's `RUN_FROZEN` refusal notice inline. This is the screen-inventory rule that
dangerous-action protections are Worker-enforced invariants, never UI tricks (ADR-0023) — a locked
field the CLI or an agent could write straight past would be a screen that lies.

One owner at a time is also the easiest rule to reason about: no silent divergence between the live
Flag and the Run, and no second source of truth. Allowing the write and ignoring it would be worse
than either, because the mutated value would be invisible while the Run lasted and would then take
effect the moment it ended — a silent delayed action, the disguised default ADR-0036 bans.

The baseline `rollout` is frozen for exactly that reason: the Run's allocation is the sole authority
for its traffic, so an accepted baseline edit would report "applied" for a change that moves nobody
until the Run ends.

### Kill switch is always exempt

The enable/disable kill switch is **never** locked, even while an Experiment runs. An operator must
always be able to turn a flag off in an incident. Killing an experiment-controlled flag is a loud,
logged event; its effect on the running Run (end / invalidate) is designed in the experiment
lifecycle spec.
