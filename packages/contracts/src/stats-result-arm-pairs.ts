import type { z } from "zod";

export function applyArmResultPairRefine(
  arm: {
    ropeVerdict?: unknown;
    ropeVerdictUnavailable?: unknown;
    ropeScale?: unknown;
    futilityVerdict?: unknown;
    futilityBecause?: unknown;
    absolute_ci_lower?: unknown;
    absolute_ci_upper?: unknown;
    simultaneous_absolute_ci_lower?: unknown;
    simultaneous_absolute_ci_upper?: unknown;
    simultaneous_ci_lower?: unknown;
    simultaneous_ci_upper?: unknown;
    eligible_n?: unknown;
    immature_excluded_n?: unknown;
  },
  context: z.RefinementCtx,
): void {
  requireTogether(
    context,
    arm.eligible_n,
    arm.immature_excluded_n,
    "eligible_n and immature_excluded_n must be present together",
  );
  requireTogether(
    context,
    arm.futilityVerdict,
    arm.futilityBecause,
    "futilityVerdict and futilityBecause must be present together",
  );
  requireTogether(
    context,
    arm.absolute_ci_lower,
    arm.absolute_ci_upper,
    "absolute_ci_lower and absolute_ci_upper must be present together",
  );
  requireTogether(
    context,
    arm.simultaneous_absolute_ci_lower,
    arm.simultaneous_absolute_ci_upper,
    "simultaneous_absolute_ci_lower and simultaneous_absolute_ci_upper must be present together",
  );
  requireTogether(
    context,
    arm.simultaneous_ci_lower,
    arm.simultaneous_ci_upper,
    "simultaneous_ci_lower and simultaneous_ci_upper must be present together",
  );
  refineRopePair(arm, context);
}

function refineRopePair(
  arm: {
    ropeVerdict?: unknown;
    ropeVerdictUnavailable?: unknown;
    ropeScale?: unknown;
  },
  context: z.RefinementCtx,
): void {
  if (arm.ropeVerdict !== undefined && arm.ropeVerdictUnavailable !== undefined) {
    context.addIssue({
      code: "custom",
      message: "ropeVerdict and ropeVerdictUnavailable are mutually exclusive",
    });
  }
  if (arm.ropeVerdict !== undefined && arm.ropeScale === undefined) {
    context.addIssue({
      code: "custom",
      message: "ropeScale is required when ropeVerdict is present",
    });
  }
  if (arm.ropeVerdict === undefined && arm.ropeScale !== undefined) {
    context.addIssue({
      code: "custom",
      message: "ropeScale requires ropeVerdict",
    });
  }
}

function requireTogether(
  context: z.RefinementCtx,
  left: unknown,
  right: unknown,
  message: string,
): void {
  if ((left === undefined) !== (right === undefined)) {
    context.addIssue({ code: "custom", message });
  }
}
