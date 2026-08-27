import { targetingRuleDuplicateIdIssues } from "@splitch/contracts";
import type { ApplicationOutcome } from "./approval-service-types";
import type { FlagConfigWriteResult } from "./config-store-types";
import { runFrozenError } from "./flag-config-run-freeze";

/**
 * Map a refused approved Flag Configuration write to a Review outcome.
 * Exported so deleting the terminal `CHANGED_FIELDS_UNDETERMINED` branch is a
 * red unit test rather than a silent fall-through to a retryable 500.
 */
export function mapApprovedFlagConfigFailure(
  result: Extract<FlagConfigWriteResult, { ok: false }>,
  flagId: string,
  environmentId: string,
): ApplicationOutcome {
  if (result.reason === "APPROVAL_NOT_APPLIED") {
    return { ok: false as const, notApplied: true as const };
  }
  // The Run started after this proposal was minted. Approving it can never be a
  // legal way to move the field, so the Request is resolved rather than parked.
  if (result.reason === "RUN_FROZEN") {
    const { message, details } = runFrozenError(result);
    return { ok: false as const, unapplicable: { code: "RUN_FROZEN", message, details } };
  }
  // A proposal whose changed-field set cannot be read must not apply. Resolve
  // terminally with the recorded cause so an operator sees why, not a silent
  // pending retry (SPL-304 / ADR-0036).
  if (result.reason === "CHANGED_FIELDS_UNDETERMINED") {
    return {
      ok: false as const,
      unapplicable: {
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Approval Request changed-field set could not be determined; refuse rather than apply",
        details: { fault: "approval_changed_fields_undetermined" },
      },
    };
  }
  if (result.reason === "APPROVAL_EMPTY_CHANGE") {
    return {
      ok: false as const,
      unapplicable: {
        code: "INTERNAL_SERVER_ERROR",
        message:
          "Approval Request does not change any Flag Configuration field that can be applied",
        details: { fault: "approval_empty_change" },
      },
    };
  }
  if (result.reason === "TARGETING_RULE_ID_CONFLICT") {
    return {
      ok: false as const,
      targetState: "rolled_back" as const,
      error: {
        code: "VALIDATION_ERROR" as const,
        details: {
          issues: targetingRuleDuplicateIdIssues(result.targetingRules).map((issue) => ({
            path: ["body", ...issue.path.map(String)],
            message: issue.message,
          })),
        },
      },
    };
  }
  if (result.reason === "VARIANT_NOT_AVAILABLE") {
    return {
      ok: false as const,
      targetState: "rolled_back" as const,
      error: {
        code: "VARIANT_NOT_AVAILABLE" as const,
        details: {
          flagId,
          environmentId,
          missingVariants: result.missingVariants,
          recommendedAction: "ADD_VARIANT_TO_ENV",
        },
      },
    };
  }
  // The one reason the approved write reports from BOTH sides of its D1
  // mutation: the pre-write snapshot read and the post-commit re-read
  // (`config-store-approved-write.ts`). Nothing here separates them, so it does
  // not get to claim a rollback.
  if (result.reason === "FLAG_NOT_FOUND") {
    return {
      ok: false as const,
      targetState: "unknown" as const,
      error: { code: "INTERNAL_SERVER_ERROR" as const, details: {} },
    };
  }
  return {
    ok: false as const,
    targetState: "rolled_back" as const,
    error: { code: "INTERNAL_SERVER_ERROR" as const, details: {} },
  };
}
