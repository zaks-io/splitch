import { describe, expect, it } from "vitest";
import {
  DEFAULT_MUTATING_JSON_BODY_LIMIT,
  DEFAULT_MUTATING_JSON_BODY_MAX_BYTES,
  rawBodyByteLimitFor,
} from "./route-contract";
import { routeRegistry } from "./route-registry";

const SMALLER_LIMIT = {
  maxBytes: 8,
  error: {
    code: "VALIDATION_ERROR" as const,
    message: "request body is too large",
    details: { issues: [{ path: ["body"], message: "body is too large" }] },
  },
};

describe("rawBodyByteLimitFor", () => {
  it("defaults every mutating method that omits a limit", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(rawBodyByteLimitFor({ method })).toEqual(DEFAULT_MUTATING_JSON_BODY_LIMIT);
    }
  });

  it("preserves a smaller explicit route limit", () => {
    expect(rawBodyByteLimitFor({ method: "POST", rawBodyByteLimit: SMALLER_LIMIT })).toEqual(
      SMALLER_LIMIT,
    );
  });

  it("does not invent a limit for GET", () => {
    expect(rawBodyByteLimitFor({ method: "GET" })).toBeUndefined();
  });

  it("keeps an explicit GET limit if a contract declares one", () => {
    expect(rawBodyByteLimitFor({ method: "GET", rawBodyByteLimit: SMALLER_LIMIT })).toEqual(
      SMALLER_LIMIT,
    );
  });
});

describe("route registry: mutating routes are bounded", () => {
  it("never leaves a mutating registry route unbounded after the registrar default", () => {
    for (const route of routeRegistry) {
      const limit = rawBodyByteLimitFor(route);
      if (route.method === "GET") {
        expect(limit).toBe(route.rawBodyByteLimit);
        continue;
      }
      expect(limit).toBeDefined();
      expect(limit?.maxBytes).toBe(
        route.rawBodyByteLimit?.maxBytes ?? DEFAULT_MUTATING_JSON_BODY_MAX_BYTES,
      );
      if (route.rawBodyByteLimit !== undefined) {
        expect(route.rawBodyByteLimit.maxBytes).toBeLessThanOrEqual(
          DEFAULT_MUTATING_JSON_BODY_MAX_BYTES,
        );
      }
    }
  });
});
