import { describe, expect, it } from "vitest";
import { createRoute } from "@hono/zod-openapi";
import { defineApiRoute } from "./openapi-route";
import { AppParams } from "./routes/route-shapes";
import { z } from "./openapi-route";
import { FlagResponseSchema } from "./resource-envelopes-flag";

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
});
