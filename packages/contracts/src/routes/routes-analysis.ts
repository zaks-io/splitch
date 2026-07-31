import { z } from "@hono/zod-openapi";
import { TestEvaluationRequestSchema, TestEvaluationResponseSchema } from "../wire-envelopes-core";
import { OrganizationUsageResponseSchema } from "../resource-envelopes-usage";
import { AnalysisResultsEnvelopeSchema } from "../stats-result-contract";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { AppParams, EnvFlagParams, ExperimentParams, OrgParams } from "./route-shapes";

/**
 * Control-plane-AUTHORIZED reads that do not all live on the Control Plane Worker:
 * test-eval (Evaluation Worker), experiment results + audit log (Analysis Worker),
 * and the unauthenticated OpenAPI discovery doc (Control Plane Worker).
 * Endpoint canon: docs/spec/control-plane/endpoints-test-eval-analytics.md.
 */

const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

const ResultsSelectorSchema = z.object({ runId: z.string().optional() }).strict();
const OptionalResultsSelectorSchema = ResultsSelectorSchema.default({});

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

export const analysisRoutes = [
  defineApiRoute({
    operationId: "flags_test_eval",
    owner: "evaluation-api",
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/flags/:flagId/test-eval",
    summary: "Dry-run resolve a Flag with the full resolution reason without firing an Exposure.",
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
    summary: "Get an Experiment's results envelope (Run id, Control Variant, StatsOutput).",
    request: { params: ExperimentParams, query: ResultsSelectorSchema },
    response: AnalysisResultsEnvelopeSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      "EXPERIMENT_NOT_FOUND",
      "RUN_NOT_FOUND",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "VALIDATION_ERROR",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_SERVER_ERROR",
    ],
  }),
  defineApiRoute({
    operationId: "experiment_results_post",
    owner: "analysis-api",
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/experiments/:experimentId/results",
    summary: "Get an Experiment's results envelope (Run id, Control Variant, StatsOutput).",
    request: { params: ExperimentParams, body: OptionalResultsSelectorSchema },
    response: AnalysisResultsEnvelopeSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      "EXPERIMENT_NOT_FOUND",
      "RUN_NOT_FOUND",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "VALIDATION_ERROR",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_SERVER_ERROR",
    ],
  }),
  defineApiRoute({
    operationId: "organization_usage_get",
    owner: "analysis-api",
    method: "GET",
    path: "/orgs/:orgId/usage",
    summary: "Get an Organization's current-month Evaluation usage breakdown.",
    request: { params: OrgParams },
    response: OrganizationUsageResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["UNAUTHORIZED", "FORBIDDEN", "SERVICE_UNAVAILABLE", "INTERNAL_SERVER_ERROR"],
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
] as const satisfies readonly ApiRouteContract[];
