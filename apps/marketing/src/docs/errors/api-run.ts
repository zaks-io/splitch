import type { ErrorDoc } from "./types";

export const runErrorDocs = {
  RUN_FROZEN: {
    cause:
      "The edit touches a field that a running Run freezes. Changing it mid-flight would rebucket Entities that were already measured, so the write is refused whole.",
    fix: "`details.frozenFields` names exactly what is immutable and `details.recommendedAction` names the way out. An assignment field (`salt`, `allocation`, `variantSet`, `targetingRules`, `targetingSegmentId`, `experiment.targetingKey`, `activationMetricId`) returns `CREATE_NEW_RUN`, because a draft Run holds that field and the change applies cleanly there. An App-level or Flag Configuration field (`flagConfig.*`, `variant.value`) returns `END_RUNNING_RUN_FIRST`, because no draft Run has a destination for it.",
    details:
      "{ frozenFields: string[], currentRunId: string, attemptedChange: string, recommendedAction: RecommendedAction }",
    // Left unset deliberately: the token depends on which field was frozen, and
    // printing one of the two here would contradict half the responses.
    related: ["DECISION_LOCKED", "TARGETING_KEY_MISMATCH", "EXPERIMENT_RUNNING"],
  },
  DECISION_LOCKED: {
    cause:
      "A decision-family or alpha setting was edited on a running Run. These fix the statistical test, and moving them mid-Run invalidates the result.",
    fix: "Clone the Experiment into a new draft Run and set the decision family there, then Start it. `details.lockedFields` names the settings that are sealed.",
    details:
      "{ lockedFields: string[], currentRunId: string, attemptedChange: string, recommendedAction: RecommendedAction }",
    recommendedAction: "CREATE_NEW_RUN",
    related: ["RUN_FROZEN", "EXPERIMENT_NO_DRAFT"],
  },
  TARGETING_KEY_MISMATCH: {
    cause:
      "The Targeting Key changed on a Run that is already assigning traffic. Every Entity would rebucket, and the Exposures already recorded would describe a different population than the ones that follow.",
    fix: "Start a new Run with the new Targeting Key. The old Run keeps its measured cohort intact; the new one buckets from scratch.",
    details:
      "{ currentTargetingKey: string, attemptedTargetingKey: string, experimentId: string, recommendedAction: RecommendedAction }",
    recommendedAction: "CREATE_NEW_RUN",
    related: ["RUN_FROZEN", "MULTIPLE_VARIANT_CONFLICT"],
  },
  RUN_NOT_RUNNING: {
    cause:
      "An operation that only a live Run supports (End, for example) was called on a Run that is still a draft or already ended.",
    fix: "Check `details.currentState`. A `draft` Run needs Start first; an `ended` Run is terminal, so create a new Run instead of reopening it.",
    details:
      '{ runId: string, currentState: "draft" | "ended", attemptedOp: string, recommendedAction: RecommendedAction }',
    recommendedAction: "START_A_RUN",
    related: ["EXPERIMENT_NO_DRAFT", "RUN_NOT_FOUND"],
  },
  EXPERIMENT_RUNNING: {
    cause:
      "The operation is blocked while the Experiment has a live Run. Delete is the common one.",
    fix: "End the Run named in `details.runningRunId`, then retry. Ending is deliberate: it stops assignment and seals the measured window rather than discarding it.",
    details:
      "{ experimentId: string, runningRunId: string, attemptedOp: string, recommendedAction: RecommendedAction }",
    recommendedAction: "END_RUNNING_RUN_FIRST",
    related: ["RUN_FROZEN", "RESOURCE_NOT_EMPTY"],
  },
  EXPERIMENT_NO_DRAFT: {
    cause:
      "Start was called but the draft is identical to the Run already live. Starting it would open a second Run that measures the same configuration, splitting one cohort across two Runs for no reason.",
    fix: "Edit the draft so it differs from the current Run, then Start. `details.currentRunId` is the Run it matched, or `null` when no Run has ever started.",
    details:
      "{ experimentId: string, currentRunId: string | null, recommendedAction: RecommendedAction }",
    recommendedAction: "EDIT_DRAFT_THEN_START",
    related: ["RUN_NOT_RUNNING", "DECISION_LOCKED"],
  },
  VARIANT_NOT_AVAILABLE: {
    cause:
      "A referenced Variant is not promoted into this Environment. Flag definitions are App-level, but the set of Variants servable in a given Environment is per-Environment.",
    fix: "Promote the Variants in `details.missingVariants` into the Environment (`splitch flags promote`, `flags_promote`), then retry.",
    details:
      "{ flagId: string, environmentId: string, missingVariants: string[], recommendedAction: RecommendedAction }",
    recommendedAction: "ADD_VARIANT_TO_ENV",
    related: ["VARIANT_NOT_FOUND", "FLAG_NOT_FOUND"],
  },
  RESOURCE_NOT_EMPTY: {
    cause:
      "A destructive delete was refused because child resources still exist under the target and this delete does not cascade.",
    fix: "`details.blockers` lists every current child by ID and the CLI command that removes it (CLI vocabulary). `childType`/`childCount` summarize the first group for back-compat. Remove the children (or use `apps delete --force`), then delete the parent. The refusal is deliberate: a silent cascade would take down more than the call named.",
    details:
      '{ resourceType: "app" | "environment" | "flag" | "variant" | "organization", resourceId: string, childType: string, childCount: number, attemptedOp: string, blockers?: Array<{ resourceType, resourceId, childType, children: Array<{ id, removeCommand }> }> }',
    related: ["EXPERIMENT_RUNNING", "LAST_ENVIRONMENT_REQUIRED"],
  },
} satisfies Record<string, ErrorDoc>;
