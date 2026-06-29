import { z } from "@hono/zod-openapi";
import {
  TestEvaluationRequestSchema,
  TestEvaluationResponseSchema,
} from "../wire-envelopes-core.js";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route.js";
import { AppParams, EnvFlagParams, ExperimentParams } from "./route-shapes.js";

/**
 * Control-plane-AUTHORIZED reads that do not all live on the Control Plane Worker:
 * test-eval (Evaluation Worker), experiment results + audit log (Analysis Worker),
 * and the unauthenticated OpenAPI discovery doc (Control Plane Worker).
 * Endpoint canon: docs/spec/control-plane/endpoints-test-eval-analytics.md.
 */

const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

// The metrics payload is owned by a later stats slice (stats/result-contracts.md);
// this route advertises the readiness envelope and carries the payload opaquely
// (present-with-null) until that schema lands, rather than redefining it here.
const ResultsResponseSchema = z.object({
  state: z.enum(["warming_up", "ready", "insufficient_data"]),
  asOf: z.string(),
  nextPollAfterMs: z.number().nullable(),
  metrics: z.unknown().nullable(),
});

const ResultsQuerySchema = z.object({ runId: z.string().optional() });

const AuditEventSchema = z.object({
  eventId: z.string(),
  environmentId: z.string().nullable(),
  actor: z.string(),
  action: z.string(),
  at: z.string(),
});
const AuditLogResponseSchema = z.object({
  items: z.array(AuditEventSchema),
  cursor: z.string().nullable(),
  limit: z.number(),
  total: z.number().nullable(),
});
const AuditLogQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
  environmentId: z.string().optional(),
});

export const analysisRoutes: readonly ApiRouteContract[] = [
  defineApiRoute({
    operationId: "flags_test_eval",
    owner: "evaluation-api",
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/flags/:flagId/test-eval",
    summary: "Dry-run resolve a Flag (full reason, fires no Exposure, ADR-0026).",
    request: { params: EnvFlagParams, body: TestEvaluationRequestSchema },
    response: TestEvaluationResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["FLAG_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "experiment_results_get",
    owner: "analysis-api",
    method: "GET",
    path: "/apps/:appId/envs/:environmentId/experiments/:experimentId/results",
    summary: "Get an Experiment's analysis summary (readiness-enveloped, polled).",
    request: { params: ExperimentParams, query: ResultsQuerySchema },
    response: ResultsResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["EXPERIMENT_NOT_FOUND", "RUN_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "audit_log_list",
    owner: "analysis-api",
    method: "GET",
    path: "/apps/:appId/audit-log",
    summary: "List an App's audit events (cursor-paginated, Tinybird-backed).",
    request: { params: AppParams, query: AuditLogQuerySchema },
    response: AuditLogResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "INVALID_PAGINATION"],
  }),
  defineApiRoute({
    operationId: "openapi_document_get",
    owner: "control-plane-api",
    method: "GET",
    path: "/.well-known/openapi.json",
    summary: "Serve the generated OpenAPI 3.1 document (unauthenticated discovery).",
    response: z.unknown(),
    auth: "public",
    rateLimit: "none",
    idempotency: "none",
    errors: [],
  }),
];
