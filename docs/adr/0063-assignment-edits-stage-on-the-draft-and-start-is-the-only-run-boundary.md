# Assignment edits stage on the draft, and Start is the only Run boundary

**Status:** accepted; supersedes the assignment-edit mechanics of
[ADR-0003](./0003-material-edits-including-measurement-open-a-new-run.md)

ADR-0003 sorts Experiment edits by what they invalidate: assignment edits make Exposures before and
after incomparable, measurement edits recompute over the existing Run. That sorting stands, as do its
measurement-edit and decision-spec rules. What changes is how an assignment edit takes effect. ADR-0003
had the edit itself end the current Run and open the next. An edit now never moves a Run boundary:

- **An assignment PATCH during a running Run must say it targets the next Run.** Without
  `stageForNextRun: true` it is refused with `409 RUN_FROZEN`. With the marker it writes the
  Experiment's single next-Run draft, and the response names the live Run as unaffected
  (`liveRunUnaffected`).
- **Only `allocation`, `salt`, `targetingRules`, and `segmentIds` can be staged.** Each has a draft
  column, and a later staged PATCH keeps whatever an earlier one put there.
- **`flagId`, `targetingKey`, `targetingKeyType`, and `activationMetricId` cannot be staged.** They
  live only on the Experiment row the running Run publishes, so writing one mid-Run would repoint a
  frozen Run. Changing one means End the Run, PATCH, then Start
  (`recommendedAction: END_RUNNING_RUN_FIRST`). Resending the current value is a no-op. The Variant
  set is never PATCHed; Start derives it from the Flag's Variant catalog and the allocation.
- **Start is the only operation that ends the live Run and opens the next.** One D1 batch ends the
  running Run, inserts the new one from the draft, and repoints the Experiment. Start mints a fresh
  salt unless one was staged, so the next Run re-randomizes by default. N staged edits cost one
  sample reset.

## Considered options

- **The edit rolls the Run over** (ADR-0003 as written) — rejected. Each edit resets the sample, the
  boundary lands wherever the last edit happened to land, and a typo fix to a Targeting Rule silently
  costs the accumulated data.
- **Stage without a marker** (any assignment PATCH during a Run goes to the draft) — rejected. An
  operator who meant to change the live Run would get a `200` that changed nothing they can observe.
  The marker makes the caller say which Run they mean, and the refusal without it is the loud signal.
- **Draft columns for every assignment field** — not built. The unstageable fields redefine the
  Experiment's Flag, Entity, or analysis entry population and change rarely, so ending the Run first
  is the honest path until a real need for staging them appears.

## Consequences

- A Run boundary is one explicit, reviewable action. Start can require approval under Environment
  Policy ([ADR-0029](./0029-environment-policy-configurable-per-change-type-confirmation-gates.md)),
  so a gated Environment gates every boundary, not every edit.
- Changing an unstageable field leaves a gap with no running Run between End and Start.
- ADR-0002's invariant is unchanged: a Run's assignment config is frozen for its whole life.
