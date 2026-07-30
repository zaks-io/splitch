import { describe, expect, it } from "vitest";
import { errorStatusByCode, httpStatusForError } from "./error-status";
import { ErrorCodeSchema, ErrorResponseSchema, errorCodes } from "./errors";

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
    expect(httpStatusForError("APPROVAL_REQUEST_RESOLVED")).toBe(409);
    expect(httpStatusForError("APPROVAL_APPLICATION_FAILED")).toBe(409);
    expect(httpStatusForError("IDEMPOTENCY_KEY_CONFLICT")).toBe(409);
    expect(httpStatusForError("RATE_LIMITED")).toBe(429);
    expect(httpStatusForError("INTERNAL_SERVER_ERROR")).toBe(500);
    expect(httpStatusForError("SERVICE_UNAVAILABLE")).toBe(503);
  });

  it("every enum member is a valid ErrorCodeSchema value", () => {
    for (const code of errorCodes) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("removes the legacy Confirmation error and recovery action", () => {
    expect(errorCodes).not.toContain("CONFIRMATION_REQUIRED");
    expect(ErrorCodeSchema.safeParse("CONFIRMATION_REQUIRED").success).toBe(false);
  });
});
