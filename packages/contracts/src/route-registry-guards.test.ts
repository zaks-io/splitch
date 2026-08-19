import { describe, expect, it } from "vitest";
import { defineApiRoute, z } from "./openapi-route";
import type { ApiRouteContract, DefineApiRouteInput } from "./openapi-route";
import { assertRegistry } from "./route-registry";
import type { ErrorCode } from "./errors";
import type { RouteContract } from "./route-contract";

/**
 * Fail-loud proofs for the registry's contract guards. A malformed registry must
 * throw at validation time (and unknown ErrorCodes at typecheck time), never ship
 * silently — the registry is cross-cutting, a quiet gap poisons every consumer.
 */

function sampleRoute(over: Partial<DefineApiRouteInput> = {}): ApiRouteContract {
  return defineApiRoute({
    operationId: "things_get",
    owner: "control-plane-api",
    method: "GET",
    path: "/things",
    summary: "sample",
    response: z.object({ ok: z.boolean() }),
    auth: "public",
    rateLimit: "none",
    idempotency: "none",
    errors: [],
    ...over,
  });
}

describe("registry guard: duplicate operationId fails loud", () => {
  it("throws when two routes share an operationId", () => {
    const a = sampleRoute({ operationId: "things_get" });
    const b = sampleRoute({ operationId: "things_get", path: "/things/:id" });
    expect(() => assertRegistry([a, b])).toThrow(/duplicate operationId "things_get"/);
  });

  it("accepts distinct operationIds", () => {
    const a = sampleRoute({ operationId: "things_get" });
    const b = sampleRoute({ operationId: "things_list", path: "/things" });
    expect(() => assertRegistry([a, b])).not.toThrow();
  });
});

describe("registry guard: operationId casing fails loud", () => {
  it("throws on a non-snake_case operationId", () => {
    const bad = sampleRoute({ operationId: "ThingsGet" });
    expect(() => assertRegistry([bad])).toThrow(/not lower snake_case/);
  });

  it("throws on a trailing/double underscore operationId", () => {
    const bad = sampleRoute({ operationId: "things__get" });
    expect(() => assertRegistry([bad])).toThrow(/not lower snake_case/);
  });
});

describe("registry guard: unknown ErrorCode fails loud at runtime", () => {
  it("throws when a route declares an ErrorCode outside the enum", () => {
    // Cast past the compile-time ErrorCode guard to prove the runtime check ALSO
    // fires (defense in depth): a hand-edited/JSON-sourced registry can't smuggle
    // an unknown code past validation.
    const bad = {
      ...sampleRoute(),
      errors: ["NOT_A_REAL_ERROR_CODE" as ErrorCode],
    };
    expect(() => assertRegistry([bad])).toThrow(/unknown ErrorCode "NOT_A_REAL_ERROR_CODE"/);
  });

  it("accepts a route whose errors are all valid ErrorCodes", () => {
    const ok = sampleRoute({ errors: ["FLAG_NOT_FOUND", "FORBIDDEN"] });
    expect(() => assertRegistry([ok])).not.toThrow();
  });
});

describe("registry guard: unknown ErrorCode fails TYPECHECK", () => {
  it("rejects an unknown ErrorCode literal at compile time", () => {
    // @ts-expect-error — "NOPE" is not an ErrorCode; this line must fail tsc.
    const _bad: DefineApiRouteInput["errors"] = ["NOPE"];
    expect(true).toBe(true);
  });
});

describe("registry guard: produced route satisfies the worker-runtime RouteContract", () => {
  it("an ApiRouteContract is structurally a RouteContract the registrar consumes", () => {
    // Assignability is the contract: worker-runtime's registrar.mount takes a
    // RouteContract<Input, Output>. If the produced shape drifts, this fails tsc.
    const route = sampleRoute();
    const asContract: RouteContract = route;
    expect(asContract.id).toBe(route.operationId);
    expect(asContract.input).toBeDefined();
    expect(asContract.output).toBeDefined();
    expect(asContract.auth).toBe("public");
  });
});
