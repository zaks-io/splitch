import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROL_PLANE_JSON_BODY_LIMIT,
  DEFAULT_CONTROL_PLANE_JSON_BODY_MAX_BYTES,
  DEFAULT_MUTATING_JSON_BODY_LIMIT,
  DEFAULT_MUTATING_JSON_BODY_MAX_BYTES,
  rawBodyByteLimitFor,
} from "./route-contract";
import { getRoute, routeRegistry } from "./route-registry";

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
      expect(rawBodyByteLimitFor({ method, auth: "public" })).toEqual(
        DEFAULT_MUTATING_JSON_BODY_LIMIT,
      );
    }
  });

  it("uses the larger control-plane default for authenticated writes", () => {
    expect(rawBodyByteLimitFor({ method: "POST", auth: "control-plane-token" })).toEqual(
      DEFAULT_CONTROL_PLANE_JSON_BODY_LIMIT,
    );
  });

  it("preserves a smaller explicit route limit", () => {
    expect(
      rawBodyByteLimitFor({
        method: "POST",
        auth: "control-plane-token",
        rawBodyByteLimit: SMALLER_LIMIT,
      }),
    ).toEqual(SMALLER_LIMIT);
  });

  it("preserves a larger explicit route limit", () => {
    const larger = {
      maxBytes: DEFAULT_CONTROL_PLANE_JSON_BODY_MAX_BYTES + 1,
      error: SMALLER_LIMIT.error,
    };
    expect(
      rawBodyByteLimitFor({ method: "POST", auth: "public", rawBodyByteLimit: larger }),
    ).toEqual(larger);
  });

  it("does not invent a limit for GET", () => {
    expect(rawBodyByteLimitFor({ method: "GET", auth: "public" })).toBeUndefined();
  });

  it("keeps an explicit GET limit if a contract declares one", () => {
    expect(
      rawBodyByteLimitFor({ method: "GET", auth: "public", rawBodyByteLimit: SMALLER_LIMIT }),
    ).toEqual(SMALLER_LIMIT);
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
        route.rawBodyByteLimit?.maxBytes ??
          (route.auth === "control-plane-token"
            ? DEFAULT_CONTROL_PLANE_JSON_BODY_MAX_BYTES
            : DEFAULT_MUTATING_JSON_BODY_MAX_BYTES),
      );
    }
  });

  it("gives Flag Configuration writes the control-plane ceiling, not 32 KiB", () => {
    const route = getRoute("flags_create");
    expect(route).toBeDefined();
    if (route === undefined) return;
    expect(rawBodyByteLimitFor(route)).toEqual(DEFAULT_CONTROL_PLANE_JSON_BODY_LIMIT);
  });
});
