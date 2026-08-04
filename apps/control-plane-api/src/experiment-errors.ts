import { renderError } from "@splitch/worker-runtime";

export function experimentNotFound(requestId: string): Response {
  return renderError(
    { code: "EXPERIMENT_NOT_FOUND", message: "Experiment not found", details: {} },
    { requestId },
  );
}

export function experimentKeyConflict(
  key: string,
  holder: { id: string; status: string },
  requestId: string,
): Response {
  const archived = holder.status === "archived";
  return renderError(
    {
      code: "EXPERIMENT_KEY_CONFLICT",
      message: archived
        ? "an archived Experiment already holds this key in this Environment"
        : "an Experiment already holds this key in this Environment",
      details: {
        key,
        status: holder.status as "draft" | "running" | "ended" | "archived",
        ...(archived ? { archivedExperimentId: holder.id } : {}),
        recommendedAction: "CHOOSE_DIFFERENT_KEY",
      },
    },
    { requestId },
  );
}

export function runNotFound(requestId: string): Response {
  return renderError(
    { code: "RUN_NOT_FOUND", message: "Run not found", details: {} },
    { requestId },
  );
}

export function experimentNoDraft(
  experimentId: string,
  currentRunId: string | null,
  requestId: string,
): Response {
  return renderError(
    {
      code: "EXPERIMENT_NO_DRAFT",
      message: "Experiment has no draft assignment config to Start",
      details: {
        experimentId,
        currentRunId,
        recommendedAction: "EDIT_DRAFT_THEN_START",
      },
    },
    { requestId },
  );
}

export function experimentAlreadyRunningForFlag(
  experimentId: string,
  runningRunId: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "EXPERIMENT_RUNNING",
      message: "another Experiment is already running for this Flag in this Environment",
      details: {
        experimentId,
        runningRunId,
        attemptedOp: "START_EXPERIMENT_RUN",
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    },
    { requestId },
  );
}

export function allocationInvalid(
  allocation: Record<string, number>,
  got: number,
  requestId: string,
): Response {
  return renderError(
    {
      code: "ALLOCATION_INVALID",
      message: "allocation percentages must sum to 100",
      details: {
        expected: 100,
        got,
        variantAllocations: allocation,
      },
    },
    { requestId },
  );
}

export function variantNotAvailable(
  flagId: string,
  environmentId: string,
  missingVariants: string[],
  requestId: string,
): Response {
  return renderError(
    {
      code: "VARIANT_NOT_AVAILABLE",
      message: "requested variants are not available for this Environment",
      details: {
        flagId,
        environmentId,
        missingVariants,
        recommendedAction: "ADD_VARIANT_TO_ENV",
      },
    },
    { requestId },
  );
}

export function segmentReferenceMissing(
  experimentId: string,
  missingSegmentIds: string[],
  requestId: string,
): Response {
  // Fail loud rather than freeze a Run with a silently-dropped Segment rule
  // (which would target the entire audience). Details are empty per the
  // SEGMENT_NOT_FOUND contract; the offending IDs go in the message.
  return renderError(
    {
      code: "SEGMENT_NOT_FOUND",
      message: `Experiment ${experimentId} references Segment(s) that no longer exist: ${missingSegmentIds.join(", ")}. Edit the draft before starting.`,
      details: {},
    },
    { requestId },
  );
}

export function runNotRunning(runId: string, requestId: string): Response {
  return renderError(
    {
      code: "RUN_NOT_RUNNING",
      message: "Run is not running",
      details: {
        runId,
        currentState: "ended",
        attemptedOp: "END_RUN",
        recommendedAction: "START_A_RUN",
      },
    },
    { requestId },
  );
}

export function runFrozen(
  runId: string,
  fields: string[],
  attemptedChange: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "RUN_FROZEN",
      message: "running Run freezes assignment-affecting Experiment fields",
      details: {
        frozenFields: fields,
        currentRunId: runId,
        attemptedChange,
        recommendedAction: "CREATE_NEW_RUN",
      },
    },
    { requestId },
  );
}

/**
 * `stageForNextRun` only reaches fields the Experiment holds a draft column for.
 * The rest have to fail loud rather than land on the live row, which is exactly
 * what the running Run's published ExperimentConfig reads from.
 */
export function runFrozenUnstageable(runId: string, fields: string[], requestId: string): Response {
  return renderError(
    {
      code: "RUN_FROZEN",
      message: `${fields.join(", ")} cannot be staged for the next Run because the Experiment stores no draft for them; writing them now would repoint running Run ${runId}. End that Run, then PATCH these fields, then Start the next Run. allocation, salt, targetingRules and segmentIds can still be staged while the Run is running.`,
      details: {
        frozenFields: fields,
        currentRunId: runId,
        attemptedChange: "PATCH_EXPERIMENT_STAGE_FOR_NEXT_RUN",
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    },
    { requestId },
  );
}

/**
 * A Run's variantSet is derived at Start from the Flag's Variant catalog and the
 * staged allocation. Accepting it here would 200 an edit that lands nowhere.
 */
export function variantSetNotPatchable(requestId: string): Response {
  return renderError(
    {
      code: "VALIDATION_ERROR",
      message: "request failed schema validation",
      details: {
        issues: [
          {
            path: ["body", "variantSet"],
            message:
              "variantSet is not an editable Experiment field. A Run's Variant set is derived at Start from the Flag's Variant catalog and the staged allocation. Edit the Variants on the Flag (/flags/:flagId/variants) and set allocation here instead.",
          },
        ],
      },
    },
    { requestId },
  );
}

export function decisionLocked(
  runId: string,
  fields: string[],
  attemptedChange: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "DECISION_LOCKED",
      message: "running Run locks decision-valid fields",
      details: {
        lockedFields: fields,
        currentRunId: runId,
        attemptedChange,
        recommendedAction: "CREATE_NEW_RUN",
      },
    },
    { requestId },
  );
}

export function configStoreUnavailable(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "config store is not configured",
      details: { retryAfterMs: 1000 },
    },
    { requestId },
  );
}

/** Archive UPDATE refused on a still-visible Experiment (e.g. concurrent End). */
export function experimentDeleteConflict(requestId: string): Response {
  return renderError(
    {
      code: "SERVICE_UNAVAILABLE",
      message: "experiment archive lost a race; retry",
      details: { retryAfterMs: 0 },
    },
    { requestId },
  );
}
