import { describe, expect, it } from "vitest";
import {
  reduceRequestError,
  resolveRequestErrorStatus,
  shouldReportRequestErrorToSentry,
} from "./request-error-sentry.js";

/**
 * The reduction runs inside the registrar's own catch block, so anything it
 * throws escapes the only handler that renders the contract-shaped 500 and the
 * caller gets Hono's plain-text default instead. These are the throw sites a
 * thrown value can actually bring with it.
 */
describe("reduceRequestError is total", () => {
  const fault = (cause: unknown) =>
    reduceRequestError({ requestId: "req-1", code: "INTERNAL_SERVER_ERROR", status: 500, cause });

  it("survives a null-prototype throw, which String() cannot convert", () => {
    expect(fault(Object.create(null)).fault).toContain("unrepresentable");
  });

  it("survives a throw whose toString itself throws", () => {
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(fault(hostile).fault).toContain("unrepresentable");
  });

  it("survives an Error whose stack getter throws", () => {
    const hostile = new Error("boom");
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("nope");
      },
    });
    expect(fault(hostile).fault).toContain("unrepresentable");
  });
});

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
    "APPROVAL_REVIEW_REQUIRED",
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
