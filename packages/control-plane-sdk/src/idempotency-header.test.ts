import { describe, expect, it } from "vitest";
import { IdempotencyKeyRequiredError, withIdempotencyHeader } from "./idempotency-header";

/**
 * `IdempotencyKeyRequiredError.errorResponse` is a contract any consumer can catch,
 * so it is pinned here, next to the module that owns it, rather than only where the
 * MCP server happens to render it (SPL-266).
 */
describe("IdempotencyKeyRequiredError", () => {
  it("carries the Worker's error code with a surface-local issue path", () => {
    const { errorResponse } = new IdempotencyKeyRequiredError("flags_delete");

    expect(errorResponse.code).toBe("VALIDATION_ERROR");
    expect(errorResponse.details).toMatchObject({
      issues: [expect.objectContaining({ path: ["idempotency_key"] })],
    });
  });
});

describe("withIdempotencyHeader", () => {
  it("refuses a blank key on a required route", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      expect(() => withIdempotencyHeader("flags_delete", {}, blank)).toThrow(
        IdempotencyKeyRequiredError,
      );
    }
  });

  it("sends no header for a blank key on an optional route", () => {
    expect(withIdempotencyHeader("apps_create", {}, "  ")).toEqual({});
  });

  it("keeps a key the caller can actually replay on", () => {
    expect(withIdempotencyHeader("flags_delete", {}, "idem_1").headers).toEqual({
      "idempotency-key": "idem_1",
    });
  });
});
