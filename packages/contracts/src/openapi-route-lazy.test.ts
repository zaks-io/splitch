import { describe, expect, it } from "vitest";
import { defineApiRoute, z } from "./openapi-route";
import { readOnlyClosed } from "./route-effects";

describe("lazy route schemas", () => {
  it("defers runtime input construction and memoizes both schema getters", () => {
    let headerChecks = 0;
    const headers = z.object({ token: z.string().optional() }).superRefine(() => {
      headerChecks += 1;
    });
    const route = defineApiRoute({
      operationId: "things_get",
      owner: "control-plane-api",
      method: "GET",
      path: "/things",
      summary: "Get things.",
      request: { headers },
      response: z.object({ ok: z.boolean() }),
      auth: "public",
      rateLimit: "none",
      idempotency: "none",
      effects: readOnlyClosed,
      errors: ["FORBIDDEN"],
    });

    expect(headerChecks).toBe(0);
    const openapi = route.openapi;
    expect(headerChecks).toBe(0);
    expect(route.openapi).toBe(openapi);
    const input = route.input;
    expect(headerChecks).toBe(1);
    expect(route.input).toBe(input);
    expect(headerChecks).toBe(1);
    expect(input.parse({})).toEqual({});
  });
});
