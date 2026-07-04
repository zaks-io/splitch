import { renderError } from "@splitch/worker-runtime";
import type { RunningBlocker } from "./flag-definition-guards";
import type { ValidationIssue } from "./flag-definition-schema";

export function validationError(requestId: string, issue: [string[], string]): Response {
  return validationErrors(requestId, [{ path: issue[0], message: issue[1] }]);
}

export function validationErrors(requestId: string, issues: ValidationIssue[]): Response {
  return renderError(
    { code: "VALIDATION_ERROR", message: "request failed schema validation", details: { issues } },
    { requestId },
  );
}

export function flagNotFound(requestId: string): Response {
  return renderError(
    { code: "FLAG_NOT_FOUND", message: "flag not found", details: {} },
    { requestId },
  );
}

export function variantNotFound(requestId: string): Response {
  return renderError(
    { code: "VARIANT_NOT_FOUND", message: "variant not found", details: {} },
    { requestId },
  );
}

export function runningExperimentError(
  blocker: RunningBlocker,
  attemptedOp: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "EXPERIMENT_RUNNING",
      message: "running Experiment must be ended before deleting this resource",
      details: {
        experimentId: blocker.experimentId,
        runningRunId: blocker.runId,
        attemptedOp,
        recommendedAction: "END_RUNNING_RUN_FIRST",
      },
    },
    { requestId },
  );
}

export function runFrozenError(
  blocker: RunningBlocker,
  frozenFields: string[],
  attemptedChange: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "RUN_FROZEN",
      message: "running Run freezes this Variant value",
      details: {
        frozenFields,
        currentRunId: blocker.runId,
        attemptedChange,
        recommendedAction: "CREATE_NEW_RUN",
      },
    },
    { requestId },
  );
}

export function resourceNotEmpty(
  resourceType: "flag" | "variant",
  resourceId: string,
  childType: string,
  childCount: number,
  attemptedOp: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "RESOURCE_NOT_EMPTY",
      message: "resource has children that must be deleted before this operation can continue",
      details: { resourceType, resourceId, childType, childCount, attemptedOp },
    },
    { requestId },
  );
}
