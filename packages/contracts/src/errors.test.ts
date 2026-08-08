import { describe, expect, it } from "vitest";
import { ErrorCodeSchema, errorCodes } from "./error-code";
import { errorStatusByCode, httpStatusForError } from "./error-status";
import { ErrorResponseSchema } from "./errors";
import {
  DecisionFailureSchema,
  DecisionResultUnavailableDetailsSchema,
} from "./experiment-conclusion-errors";

const conclusionErrorResponses = [
  {
    code: "DECISION_BLOCKED",
    message: "conclusion is blocked",
    details: {
      runId: "run_01",
      resultToken: `sha256:${"a".repeat(64)}`,
      dataWatermark: "2026-07-22T12:00:00.000Z",
      failures: [
        {
          code: "DECISION_CONTROL_IDENTITY_INVALID",
          checkIds: ["control_identity"],
          details: {
            controlVariantId: "var_control",
            frozenVariantNames: ["control", "winner"],
            reason: "absent_from_frozen_variant_set",
          },
        },
      ],
    },
  },
  {
    code: "DECISION_RESULT_STALE",
    message: "the result changed",
    details: {
      runId: "run_01",
      expectedResultToken: `sha256:${"a".repeat(64)}`,
      currentResultToken: `sha256:${"b".repeat(64)}`,
    },
  },
  {
    code: "DECISION_RESULT_UNAVAILABLE",
    message: "the result has no decision evidence",
    details: { runId: "run_01", envelopeState: "ready" },
  },
  {
    code: "TARGET_CONFIGURATION_STALE",
    message: "the target Flag Configuration changed",
    details: {
      flagId: "flag_01",
      environmentId: "env_prod",
      expectedConfigVersion: 4,
      currentConfigVersion: 5,
      recommendedAction: "REFRESH_AND_REPROPOSE",
    },
  },
] as const;

describe("ErrorResponse contract", () => {
  it("parses a structured-detail error and narrows details by code", () => {
    const parsed = ErrorResponseSchema.parse({
      code: "RUN_FROZEN",
      message: "allocation is frozen on the running Run",
      details: {
        frozenFields: ["allocation"],
        currentRunId: "run_01",
        attemptedChange: "allocation",
        recommendedAction: "CREATE_NEW_RUN",
      },
    });

    if (parsed.code === "RUN_FROZEN") {
      expect(parsed.details.recommendedAction).toBe("CREATE_NEW_RUN");
    } else {
      throw new Error("discriminant did not narrow to RUN_FROZEN");
    }
  });

  it("accepts empty details for codes that carry none", () => {
    const parsed = ErrorResponseSchema.parse({
      code: "FLAG_NOT_FOUND",
      message: "no such flag",
      details: {},
    });
    expect(parsed.code).toBe("FLAG_NOT_FOUND");
  });

  it("accepts optional fault on INTERNAL_SERVER_ERROR", () => {
    const withFault = ErrorResponseSchema.parse({
      code: "INTERNAL_SERVER_ERROR",
      message: "analysis failed",
      details: { fault: "unexpected analysis failure" },
    });
    expect(withFault.details).toEqual({ fault: "unexpected analysis failure" });
    const empty = ErrorResponseSchema.parse({
      code: "INTERNAL_SERVER_ERROR",
      message: "analysis failed",
      details: {},
    });
    expect(empty.details).toEqual({});
  });

  it("rejects a known code carrying the wrong detail shape", () => {
    const result = ErrorResponseSchema.safeParse({
      code: "RATE_LIMITED",
      message: "slow down",
      details: { nope: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown code", () => {
    const result = ErrorResponseSchema.safeParse({
      code: "NOT_A_REAL_CODE",
      message: "x",
      details: {},
    });
    expect(result.success).toBe(false);
  });

  it("keeps decision failures on the shipped gate check ids", () => {
    const parsed = DecisionFailureSchema.parse({
      code: "DECISION_CONTROL_IDENTITY_INVALID",
      checkIds: ["control_identity"],
      details: {
        controlVariantId: "var_control",
        frozenVariantNames: ["control", "winner"],
        reason: "absent_from_frozen_variant_set",
      },
    });

    expect(parsed.checkIds).toEqual(["control_identity"]);
    expect(
      DecisionFailureSchema.safeParse({
        code: "DECISION_GUARDRAIL_BREACHED",
        checkIds: ["guardrail"],
        details: {},
      }).success,
    ).toBe(false);
  });

  it("keeps activation rates nullable with their nullable source evidence", () => {
    expect(
      DecisionFailureSchema.parse({
        code: "DECISION_ACTIVATION_IMBALANCE",
        checkIds: ["activation_balance"],
        details: { pValue: null, rates: null },
      }).details,
    ).toEqual({ pValue: null, rates: null });
  });

  it("represents unavailable evidence without inventing a current result token", () => {
    expect(
      DecisionResultUnavailableDetailsSchema.parse({
        runId: "run_01",
        envelopeState: "no_data",
      }),
    ).toEqual({ runId: "run_01", envelopeState: "no_data" });
  });

  it("accepts conclusion idempotency scope", () => {
    expect(
      ErrorResponseSchema.safeParse({
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message: "the key belongs to a different conclusion payload",
        details: { scope: "conclusion", idempotencyKey: "conclude-01" },
      }).success,
    ).toBe(true);
  });

  it.each(
    conclusionErrorResponses,
  )("registers $code in the enum, status map, and response union", (response) => {
    expect(ErrorCodeSchema.safeParse(response.code).success).toBe(true);
    expect((errorStatusByCode as Record<string, number | undefined>)[response.code]).toBe(409);
    expect(ErrorResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe("HTTP status map", () => {
  it("maps every ErrorCode to a status", () => {
    for (const code of errorCodes) {
      expect(typeof errorStatusByCode[code]).toBe("number");
      expect(httpStatusForError(code)).toBe(errorStatusByCode[code]);
    }
  });

  it("has no status entries for codes outside the enum", () => {
    const mapped = Object.keys(errorStatusByCode).sort();
    const declared = [...errorCodes].sort();
    expect(mapped).toEqual(declared);
  });

  it("agrees with the spec status groupings at the boundaries", () => {
    expect(httpStatusForError("VALIDATION_ERROR")).toBe(400);
    expect(httpStatusForError("UNAUTHORIZED")).toBe(401);
    expect(httpStatusForError("FORBIDDEN")).toBe(403);
    expect(httpStatusForError("APPROVAL_REVIEW_FORBIDDEN")).toBe(403);
    expect(httpStatusForError("FLAG_NOT_FOUND")).toBe(404);
    expect(httpStatusForError("APPROVAL_REQUEST_NOT_FOUND")).toBe(404);
    expect(httpStatusForError("RUN_FROZEN")).toBe(409);
    expect(httpStatusForError("APPROVAL_REVIEW_REQUIRED")).toBe(409);
    expect(httpStatusForError("APPROVAL_REQUEST_STALE")).toBe(409);
    expect(httpStatusForError("DECISION_RESULT_STALE")).toBe(409);
    expect(httpStatusForError("TARGET_CONFIGURATION_STALE")).toBe(409);
    expect(httpStatusForError("APPROVAL_REQUEST_RESOLVED")).toBe(409);
    expect(httpStatusForError("APPROVAL_APPLICATION_FAILED")).toBe(409);
    expect(httpStatusForError("IDEMPOTENCY_KEY_CONFLICT")).toBe(409);
    expect(httpStatusForError("DECISION_BLOCKED")).toBe(409);
    expect(httpStatusForError("DECISION_RESULT_UNAVAILABLE")).toBe(409);
    expect(httpStatusForError("EVENT_ID_CONFLICT")).toBe(409);
    expect(httpStatusForError("EVENT_DEFINITION_UNPUBLISHED")).toBe(409);
    expect(httpStatusForError("EVENT_DEFINITION_IMMUTABLE")).toBe(409);
    expect(httpStatusForError("EXPOSURE_TICKET_INVALID")).toBe(400);
    expect(httpStatusForError("UNSUPPORTED_OBJECT_KEY")).toBe(400);
    expect(httpStatusForError("EXPOSURE_TICKET_EXPIRED")).toBe(410);
    expect(httpStatusForError("RATE_LIMITED")).toBe(429);
    expect(httpStatusForError("INTERNAL_SERVER_ERROR")).toBe(500);
    expect(httpStatusForError("SERVICE_UNAVAILABLE")).toBe(503);
  });

  it("every enum member is a valid ErrorCodeSchema value", () => {
    for (const code of errorCodes) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});
