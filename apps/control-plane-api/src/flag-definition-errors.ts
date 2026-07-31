import type { VariantFrozenChange, VariantRunFreeze } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import type { RunningBlocker } from "./flag-definition-guards";
import type { ValidationIssue } from "./flag-definition-schema";

export interface VariantFreezeRefusal {
  freeze: VariantRunFreeze;
  variantName: string;
  frozenChanges: VariantFrozenChange[];
}

/**
 * The `RUN_FROZEN` details for a Variant write a live Run forbids, derived ONCE
 * so the direct route and the Approval application cannot drift apart on what
 * they call the same refusal.
 *
 * `flagConfig.availableVariantNames` is the field named for a rename, not some
 * new one: renaming a Variant removes its old name from every Environment's
 * available set, which is the same act SPL-118 already refuses.
 *
 * BOTH frozen properties recommend `END_RUNNING_RUN_FIRST`, because it is the
 * only action that completes either edit. A Variant is App-level (ADR-0028) and
 * a draft Run has no destination field for a Variant name or value, so
 * `CREATE_NEW_RUN` produces a second running Run and leaves the write refused
 * exactly as before — followed literally it never terminates. That is the
 * impossible remedy ADR-0036 forbids, and it was emitted here for the value
 * branch until SPL-267 removed it. `CREATE_NEW_RUN` remains correct in
 * `docs/spec/contracts/error-responses.md` for an Experiment ASSIGNMENT edit,
 * which a draft Run really can carry.
 */
export function variantFreezeDetails(refusal: VariantFreezeRefusal) {
  const renaming = refusal.frozenChanges.includes("name");
  return {
    frozenFields: refusal.frozenChanges.map((change) =>
      change === "name" ? "flagConfig.availableVariantNames" : "variant.value",
    ),
    currentRunId: refusal.freeze.runId,
    attemptedChange: `${renaming ? "RENAME_VARIANT" : "PATCH_VARIANT"}:${refusal.variantName}`,
    recommendedAction: "END_RUNNING_RUN_FIRST" as const,
  };
}

export function variantRunFrozenError(refusal: VariantFreezeRefusal, requestId: string): Response {
  const renaming = refusal.frozenChanges.includes("name");
  return renderError(
    {
      code: "RUN_FROZEN",
      message: renaming
        ? `running Run ${refusal.freeze.runId} in Environment ${refusal.freeze.environmentId} allocates traffic to Variant "${refusal.variantName}" by name; end it before renaming this Variant`
        : `running Run ${refusal.freeze.runId} in Environment ${refusal.freeze.environmentId} is serving Variant "${refusal.variantName}"; end it before changing this Variant's value`,
      details: variantFreezeDetails(refusal),
    },
    { requestId },
  );
}

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
