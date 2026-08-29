import {
  type ErrorCode,
  ErrorResponseSchema,
  httpStatusForError,
  recommendedActions,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";

const OPERATIONAL_409_CODES = [
  "RUN_FROZEN",
  "DECISION_LOCKED",
  "TARGETING_KEY_MISMATCH",
  "RUN_NOT_RUNNING",
  "EXPERIMENT_RUNNING",
  "EXPERIMENT_NO_DRAFT",
  "VARIANT_NOT_AVAILABLE",
  "SLUG_CONFLICT",
  "EXPERIMENT_KEY_CONFLICT",
  "APPROVAL_REVIEW_REQUIRED",
  "APPROVAL_REQUEST_STALE",
  "APPROVAL_APPLICATION_FAILED",
  "TARGET_CONFIGURATION_STALE",
  "ATTENTION_FANOUT_LIMIT_EXCEEDED",
  "SELECTOR_AMBIGUOUS",
] as const satisfies readonly ErrorCode[];

describe("MCP operational error recovery contract", () => {
  it("admits machine-readable recovery guidance on every operational 409", () => {
    expect(recommendedActions).toContain("USE_CANONICAL_ID");
    for (const code of OPERATIONAL_409_CODES) {
      expect(httpStatusForError(code), code).toBe(409);
      const member = ErrorResponseSchema.options.find((option) => option.shape.code.value === code);
      if (!member) throw new Error(`missing ErrorResponse member for ${code}`);
      const details = member.shape.details as unknown as { shape: Record<string, unknown> };
      expect(details.shape, code).toHaveProperty("recommendedAction");
    }
  });
});
