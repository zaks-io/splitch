import { renderError } from "@splitch/worker-runtime";

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
