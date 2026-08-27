import { type TargetingRule, targetingRuleDuplicateIdIssues } from "@splitch/contracts";
import { renderError } from "@splitch/worker-runtime";
import { validationErrors } from "./flag-definition-errors";

/**
 * Refusals specific to a Flag Configuration write.
 *
 * `VARIANT_NOT_AVAILABLE` and `SERVICE_UNAVAILABLE` are deliberately NOT here:
 * the Experiment Start path already renders both with identical details, and one
 * error code answered by two renderers is how the two drift into disagreeing
 * about the same condition. `experiment-errors.ts` owns them for both paths.
 */

export function rolloutAmbiguous(availableVariantNames: string[], requestId: string): Response {
  return renderError(
    {
      code: "VALIDATION_ERROR",
      message:
        "a baseline rollout needs exactly one non-Default available Variant to roll traffic into",
      details: {
        issues: [
          {
            path: ["rollout"],
            message:
              `available Variants are [${availableVariantNames.join(", ")}]; narrow ` +
              "availableVariantNames to the Default Variant plus exactly one other, or use a " +
              "Targeting Rule with its own percentageRollout instead",
          },
        ],
      },
    },
    { requestId },
  );
}

export function flagConfigNotFound(requestId: string): Response {
  return renderError(
    { code: "FLAG_NOT_FOUND", message: "flag configuration not found", details: {} },
    { requestId },
  );
}

export function flagSegmentNotFound(missingSegmentIds: string[], requestId: string): Response {
  return renderError(
    {
      code: "SEGMENT_NOT_FOUND",
      message: `Targeting Rule references Segment(s) not found in this App: ${missingSegmentIds.join(", ")}`,
      details: { missingSegmentIds },
    },
    { requestId },
  );
}

export function targetingRuleIdConflict(rules: TargetingRule[], requestId: string): Response {
  const issues = targetingRuleDuplicateIdIssues(rules).map((issue) => ({
    path: ["body", ...issue.path.map(String)],
    message: issue.message,
  }));
  return validationErrors(
    requestId,
    issues.length > 0
      ? issues
      : [
          {
            path: ["body", "targetingRules"],
            message: "Targeting Rule id already exists in this Flag Configuration",
          },
        ],
  );
}

export function targetingRuleSaltRejected(indexes: number[], requestId: string): Response {
  return validationErrors(
    requestId,
    indexes.map((index) => ({
      path: ["body", "targetingRules", String(index), "percentageRollout", "salt"],
      message: "Targeting Rule bucketing salt is server-owned",
    })),
  );
}
