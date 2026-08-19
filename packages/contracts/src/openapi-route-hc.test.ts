import { createRoute } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { defineApiRoute, z } from "./openapi-route";
import { FlagResponseSchema } from "./resource-envelopes-flag";
import { AppParams } from "./routes/route-shapes";

const fromHelper = defineApiRoute({
  operationId: "flags_list",
  owner: "control-plane-api",
  method: "GET",
  path: "/apps/:appId/flags",
  summary: "List Flag definitions in an App.",
  request: { params: AppParams },
  response: z.object({ items: z.array(FlagResponseSchema) }),
  auth: "control-plane-token",
  rateLimit: "control-plane-actor",
  idempotency: "none",
  errors: ["APP_NOT_FOUND", "FORBIDDEN"],
});

const fromConfig = createRoute({
  method: "get",
  path: "/apps/{appId}/flags",
  operationId: "flags_list",
  summary: "List Flag definitions in an App.",
  request: { params: AppParams },
  responses: {
    200: {
      description: "List Flag definitions in an App.",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(FlagResponseSchema) }),
        },
      },
    },
  },
});

describe("openapi route parity", () => {
  it("defineApiRoute emits the same openapi path and method as manual createRoute", () => {
    expect(fromHelper.openapi.path).toBe(fromConfig.path);
    expect(fromHelper.openapi.method).toBe(fromConfig.method);
    expect(fromHelper.openapi.operationId).toBe(fromConfig.operationId);
  });

  it("defineApiRoute can advertise an empty-body 304 response", () => {
    const withNotModified = defineApiRoute({
      operationId: "sdk_evaluate_all",
      owner: "evaluation-api",
      method: "POST",
      path: "/api/sdk/evaluate-all",
      summary: "Resolve every Flag for one Evaluation Context.",
      request: { body: z.object({ targetingKey: z.string(), idType: z.string() }) },
      response: z.object({ evaluations: z.record(z.string(), z.unknown()) }),
      notModifiedResponse: true,
      auth: "data-plane-key",
      rateLimit: "client-key",
      idempotency: "required",
      errors: ["UNAUTHORIZED"],
    });

    expect(withNotModified.openapi.responses).toMatchObject({
      200: expect.objectContaining({ description: expect.any(String) }),
      304: { description: "Not Modified — cached response is still current." },
    });
  });

  it("fails loud when a declared error has no mapped HTTP status", () => {
    expect(() =>
      defineApiRoute({
        operationId: "things_get",
        owner: "control-plane-api",
        method: "GET",
        path: "/things",
        summary: "Get a thing.",
        response: z.object({ ok: z.boolean() }),
        auth: "public",
        rateLimit: "none",
        idempotency: "none",
        // @ts-expect-error -- bypass the authoring guard to prove generation fails loud.
        errors: ["NOT_A_REAL_ERROR_CODE"],
      }),
    ).toThrow(/has no mapped HTTP status/);
  });
});
