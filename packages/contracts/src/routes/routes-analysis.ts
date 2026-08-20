import { z } from "@hono/zod-openapi";
import { EnvironmentExposureStatusResponseSchema } from "../environment-exposure-status";
import { TestEvaluationRequestSchema, TestEvaluationResponseSchema } from "../wire-envelopes-core";
import { OrganizationUsageResponseSchema } from "../resource-envelopes-usage";
import { AnalysisResultsEnvelopeSchema } from "../stats-result-contract";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  AppParams,
  EnvFlagKeyParams,
  EnvParams,
  ExperimentParams,
  OrgParams,
} from "./route-shapes";

/**
 * Control-plane-AUTHORIZED reads that do not all live on the Control Plane Worker:
 * test-eval (Evaluation Worker), Experiment results and Organization usage
 * (Analysis Worker), and the unauthenticated OpenAPI discovery doc (Control Plane
 * Worker). Every one of them is ADDRESSED at the Control Plane, which authorizes
 * the caller and delegates to the owner over a service binding (ADR-0046).
 * Endpoint canon: docs/spec/control-plane/endpoints-test-eval-analytics.md.
 */

const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

const ResultsSelectorSchema = z.object({ runId: z.string().optional() }).strict();
const OptionalResultsSelectorSchema = ResultsSelectorSchema.default({});
const ExposureStatusDeleteQuerySchema = z
  .object({ environmentId: z.string().min(1).optional() })
  .strict();
const HoldoverWriteOutboxDeleteQuerySchema = z
  .object({
    idType: z.string().min(1).optional(),
    targetingKeyHash: z.string().min(1).optional(),
    deleteBeforeTs: z.string().datetime({ offset: true }).optional(),
    /** App deletion phase: prepare (freeze), finalize (drain), or cancel (restore). */
    phase: z.enum(["prepare", "finalize", "cancel"]).optional(),
  })
  .strict();

export const analysisRoutes = [
  defineApiRoute({
    operationId: "flags_test_eval",
    owner: "evaluation-api",
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/flags/:flagKey/test-eval",
    summary: "Dry-run resolve a Flag with the full resolution reason without firing an Exposure.",
    request: { params: EnvFlagKeyParams, body: TestEvaluationRequestSchema },
    response: TestEvaluationResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FLAG_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "experiment_results_get",
    owner: "analysis-api",
    method: "GET",
    path: "/apps/:appId/envs/:environmentId/experiments/:experimentId/results",
    summary:
      "Get an Experiment's results envelope: state ready with StatsOutput, state no_data naming the missing input, or state no_run naming Start when the Experiment has never had a Run.",
    request: { params: ExperimentParams, query: ResultsSelectorSchema },
    response: AnalysisResultsEnvelopeSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      // The delegation hop refuses an Environment that belongs to another App
      // with APP_NOT_FOUND rather than confirming it exists elsewhere.
      "APP_NOT_FOUND",
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
    summary:
      "Get an Experiment's results envelope: state ready with StatsOutput, state no_data naming the missing input, or state no_run naming Start when the Experiment has never had a Run.",
    request: { params: ExperimentParams, body: OptionalResultsSelectorSchema },
    response: AnalysisResultsEnvelopeSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      // The delegation hop refuses an Environment that belongs to another App
      // with APP_NOT_FOUND rather than confirming it exists elsewhere.
      "APP_NOT_FOUND",
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
    operationId: "environment_exposure_status_get",
    owner: "analysis-api",
    method: "GET",
    path: "/apps/:appId/envs/:environmentId/exposure-status",
    summary: "Get whether an Environment has received its first real Exposure.",
    request: { params: EnvParams },
    response: EnvironmentExposureStatusResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      "APP_NOT_FOUND",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "VALIDATION_ERROR",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_SERVER_ERROR",
    ],
  }),
  defineApiRoute({
    operationId: "environment_exposure_status_delete",
    owner: "analysis-api",
    method: "DELETE",
    path: "/internal/apps/:appId/exposure-status",
    summary: "Delete durable Exposure status when an App or Environment is deleted.",
    request: { params: AppParams, query: ExposureStatusDeleteQuerySchema },
    response: z.object({ deleted: z.literal(true) }).strict(),
    auth: "internal-worker",
    rateLimit: "none",
    idempotency: "none",
    errors: ["FORBIDDEN", "VALIDATION_ERROR", "SERVICE_UNAVAILABLE", "INTERNAL_SERVER_ERROR"],
  }),
  defineApiRoute({
    operationId: "holdover_write_outbox_delete",
    owner: "evaluation-api",
    method: "DELETE",
    path: "/internal/apps/:appId/holdover-write-outbox",
    summary:
      "Freeze, finalize, or cancel Assignment Store holdover-write outbox state on App deletion; suppress+purge on Entity deletion.",
    request: { params: AppParams, query: HoldoverWriteOutboxDeleteQuerySchema },
    response: z.object({ deleted: z.literal(true) }).strict(),
    auth: "internal-worker",
    rateLimit: "none",
    idempotency: "none",
    errors: ["FORBIDDEN", "VALIDATION_ERROR", "SERVICE_UNAVAILABLE", "INTERNAL_SERVER_ERROR"],
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
