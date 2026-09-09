import {
  ConcludeRunRequestSchema,
  ConcludeRunResponseSchema,
  CreateConclusionPromotionRequestSchema,
  CreateConclusionPromotionResponseSchema,
} from "../experiment-conclusion";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { APPROVAL_WRITE_ERRORS } from "./approval-write-errors";
import { ConclusionParams, RunParams } from "./route-shapes";

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

export const conclusionRoutes = [
  defineApiRoute({
    operationId: "runs_conclude",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/experiments/:experimentId/runs/:runId/conclusions",
    summary: "End a Run, freeze its decision evidence, and request winner Promotion.",
    request: { params: RunParams, body: ConcludeRunRequestSchema },
    response: ConcludeRunResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "required",
    errors: [
      "RUN_NOT_FOUND",
      "RUN_NOT_RUNNING",
      "FLAG_NOT_FOUND",
      "VARIANT_NOT_AVAILABLE",
      "RUN_FROZEN",
      "FORBIDDEN",
      "DECISION_BLOCKED",
      "DECISION_RESULT_STALE",
      "DECISION_RESULT_UNAVAILABLE",
      "TARGET_CONFIGURATION_STALE",
      ...APPROVAL_WRITE_ERRORS,
      "VALIDATION_ERROR",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "conclusion_promotion_requests_create",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/experiments/:experimentId/runs/:runId/conclusions/:conclusionId/promotion-requests",
    summary: "Replace a stale winner Promotion request from immutable conclusion evidence.",
    request: { params: ConclusionParams, body: CreateConclusionPromotionRequestSchema },
    response: CreateConclusionPromotionResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "required",
    errors: [
      "RUN_NOT_FOUND",
      "FORBIDDEN",
      "TARGET_CONFIGURATION_STALE",
      ...APPROVAL_WRITE_ERRORS,
      "VALIDATION_ERROR",
      "SERVICE_UNAVAILABLE",
    ],
  }),
] as const satisfies readonly ApiRouteContract[];
