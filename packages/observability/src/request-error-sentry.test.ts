import { describe, expect, it } from "vitest";
import {
  resolveRequestErrorStatus,
  shouldReportRequestErrorToSentry,
} from "./request-error-sentry.js";

describe("request-error Sentry classification", () => {
  it("treats registrar guard failures with status 0 as expected domain errors", () => {
    const ctx = { requestId: "req-1", code: "VALIDATION_ERROR", status: 0 };
    expect(resolveRequestErrorStatus(ctx)).toBe(400);
    expect(shouldReportRequestErrorToSentry(ctx)).toBe(false);
  });

  it.each([
    "UNAUTHORIZED",
    "FORBIDDEN",
    "INSUFFICIENT_SCOPES",
    "FLAG_NOT_FOUND",
    "RUN_FROZEN",
    "RATE_LIMITED",
    "CONFIRMATION_REQUIRED",
  ] as const)("does not report expected domain code %s to Sentry", (code) => {
    expect(shouldReportRequestErrorToSentry({ requestId: "req-1", code, status: 0 })).toBe(false);
  });

  it("reports INTERNAL_SERVER_ERROR to Sentry even when status is omitted", () => {
    expect(
      shouldReportRequestErrorToSentry({
        requestId: "req-1",
        code: "INTERNAL_SERVER_ERROR",
        status: 0,
      }),
    ).toBe(true);
  });

  it("reports status >= 500 to Sentry", () => {
    expect(
      shouldReportRequestErrorToSentry({
        requestId: "req-1",
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      }),
    ).toBe(true);
    expect(
      shouldReportRequestErrorToSentry({
        requestId: "req-1",
        code: "PRIVACY_JOB_FAILED",
        status: 0,
      }),
    ).toBe(true);
  });
});
