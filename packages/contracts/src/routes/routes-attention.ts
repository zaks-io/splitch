import { AppAttentionRollupResponseSchema } from "../resource-envelopes-account";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { AppParams } from "./route-shapes";

export const attentionRoutes = [
  defineApiRoute({
    operationId: "app_attention_rollup_get",
    owner: "control-plane-api",
    method: "GET",
    path: "/apps/:appId/attention-rollup",
    summary: "Read explicit per-Environment SRM and Guardrail attention for one App.",
    request: { params: AppParams },
    response: AppAttentionRollupResponseSchema,
    auth: "control-plane-token",
    rateLimit: "control-plane-actor",
    idempotency: "none",
    errors: [
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "SERVICE_UNAVAILABLE",
      "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      "INTERNAL_SERVER_ERROR",
    ],
  }),
] as const satisfies readonly ApiRouteContract[];
