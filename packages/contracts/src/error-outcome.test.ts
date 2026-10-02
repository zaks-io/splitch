import { describe, expect, it } from "vitest";
import { errorCodes } from "./error-code";
import { errorOutcomeByCode, errorOutcomes, presentErrorResponse } from "./error-outcome";
import { ErrorResponseSchema } from "./errors";

describe("error outcome class", () => {
  it("maps every ErrorCode to exactly one outcome class", () => {
    expect(Object.keys(errorOutcomeByCode).sort()).toEqual([...errorCodes].sort());
    for (const code of errorCodes) {
      expect(errorOutcomes).toContain(errorOutcomeByCode[code]);
    }
  });

  it("treats transient platform faults as retryable and terminal states as non_retryable", () => {
    expect(errorOutcomeByCode.RATE_LIMITED).toBe("retryable");
    expect(errorOutcomeByCode.SERVICE_UNAVAILABLE).toBe("retryable");
    expect(errorOutcomeByCode.INTERNAL_SERVER_ERROR).toBe("non_retryable");
    expect(errorOutcomeByCode.ACTIVATION_NOT_AVAILABLE).toBe("non_retryable");
    expect(errorOutcomeByCode.APPROVAL_REQUEST_RESOLVED).toBe("non_retryable");
    expect(errorOutcomeByCode.EVENT_DEFINITION_IMMUTABLE).toBe("non_retryable");
    expect(errorOutcomeByCode.VALIDATION_ERROR).toBe("user_action_required");
    expect(errorOutcomeByCode.FLAG_LIFECYCLE_INCOMPLETE).toBe("user_action_required");
    expect(errorOutcomeByCode.SCOPE_UNRESOLVED).toBe("user_action_required");
    expect(errorOutcomeByCode.CONTEXT_USE_INVALID).toBe("user_action_required");
  });

  it("stamps outcome from the code map without a second remedy field", () => {
    const parsed = ErrorResponseSchema.parse({
      code: "SCOPE_UNRESOLVED",
      message: "App scope is unresolved. Call context_use or pass appId explicitly.",
      details: { parameter: "appId", resource: "App" },
    });
    expect(presentErrorResponse(parsed)).toEqual({
      ...parsed,
      outcome: "user_action_required",
    });
  });

  it("marks Flag-read contract mismatches non_retryable so agents update the server", () => {
    const parsed = ErrorResponseSchema.parse({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "flags_list requested complete Flag Configurations but received an unhydrated response",
      details: { fault: "FLAG_READ_CONTRACT_MISMATCH" },
    });
    expect(presentErrorResponse(parsed).outcome).toBe("non_retryable");
  });

  it("marks Exposure claim-store INTERNAL_SERVER_ERROR faults non_retryable", () => {
    const parsed = ErrorResponseSchema.parse({
      code: "INTERNAL_SERVER_ERROR",
      message: "Exposure claim-store protocol violation",
      details: { fault: "claim_store_protocol_violation" },
    });
    expect(presentErrorResponse(parsed).outcome).toBe("non_retryable");
  });
});
