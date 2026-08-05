import { ResolutionDetailsSchema } from "../leaf-schemas-runtime";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  CachedEvaluationTelemetryRequestSchema,
  CachedEvaluationTelemetryResponseSchema,
  DataPlaneEvaluateRequestSchema,
  DataPlaneEvaluateResponseSchema,
  EvaluateAllRequestSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
} from "../wire-envelopes-core";

/**
 * Public data-plane SDK endpoints on the Evaluation Worker. These carry NO
 * `:appId` path param — `app_id` is the credential's alone (ADR-0018), so the
 * tenant-crossing footgun is absent at the route level. They are NOT MCP tools.
 *
 * - evaluate:     Client Key only; fires an Exposure as a structural side effect.
 * - peek:         API Key only; fires no Exposure and writes no Assignment Store row.
 * - verify:       mixed Client Key | API Key (data-plane-key, ADR-0037); fires no
 *                 Exposure; reuses the evaluate request and returns tiered
 *                 ResolutionDetails.
 * - evaluate-all: mixed Client Key | API Key; bulk Precomputed Evaluations for one
 *                 Evaluation Context (ADR-0048); structurally non-exposing; mints
 *                 Exposure Tickets for fresh assignments for a live Experiment Run.
 *
 * Endpoint canon: docs/spec/sdk/public-evaluate-endpoint.md,
 * exposure-accessor.md, verify-endpoint.md, evaluate-all-endpoint.md.
 */

const OWNER = "evaluation-api" as const;

export const dataPlaneRoutes = [
  defineApiRoute({
    operationId: "sdk_evaluate",
    owner: OWNER,
    method: "POST",
    path: "/api/sdk/evaluate",
    summary: "Resolve a Flag under a Client Key (fires an Exposure; non-revealing).",
    request: { body: DataPlaneEvaluateRequestSchema },
    response: DataPlaneEvaluateResponseSchema,
    auth: "client-key",
    rateLimit: "client-key",
    // Evaluation usage is billed by this caller-owned logical Evaluation id.
    // The server cannot infer whether two requests are a retry.
    idempotency: "required",
    errors: [
      "UNAUTHORIZED",
      "CREDENTIAL_REVOKED",
      "APP_MISMATCH",
      "ORIGIN_NOT_ALLOWED",
      "FLAG_NOT_FOUND",
      "VALIDATION_ERROR",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "sdk_cached_evaluation_telemetry",
    owner: OWNER,
    method: "POST",
    path: "/api/sdk/evaluation-telemetry",
    summary: "Record a non-billable, cache-hit Evaluation dimension.",
    request: { body: CachedEvaluationTelemetryRequestSchema },
    response: CachedEvaluationTelemetryResponseSchema,
    auth: "client-key",
    rateLimit: "client-key",
    idempotency: "required",
    errors: [
      "UNAUTHORIZED",
      "CREDENTIAL_REVOKED",
      "ORIGIN_NOT_ALLOWED",
      "VALIDATION_ERROR",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "sdk_peek",
    owner: OWNER,
    method: "POST",
    path: "/api/sdk/peek",
    summary: "Resolve a Flag under an API Key without firing an Exposure.",
    request: { body: DataPlaneEvaluateRequestSchema },
    response: PeekEvaluateResponseSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [
      "UNAUTHORIZED",
      "CREDENTIAL_REVOKED",
      "INSUFFICIENT_SCOPES",
      "APP_MISMATCH",
      "FLAG_NOT_FOUND",
      "VALIDATION_ERROR",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "sdk_verify",
    owner: OWNER,
    method: "POST",
    path: "/api/sdk/verify",
    summary: "Verify setup under a Client Key or API Key (no Exposure; tiered reason).",
    request: { body: DataPlaneEvaluateRequestSchema },
    response: ResolutionDetailsSchema,
    auth: "data-plane-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "client-key",
    idempotency: "none",
    errors: [
      "UNAUTHORIZED",
      "CREDENTIAL_REVOKED",
      "INSUFFICIENT_SCOPES",
      "APP_MISMATCH",
      "ORIGIN_NOT_ALLOWED",
      "FLAG_NOT_FOUND",
      "VALIDATION_ERROR",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "sdk_evaluate_all",
    owner: OWNER,
    method: "POST",
    path: "/api/sdk/evaluate-all",
    summary:
      "Resolve every Flag for one Evaluation Context (Precomputed Evaluations; no Exposure).",
    request: { body: EvaluateAllRequestSchema },
    response: EvaluateAllResponseSchema,
    notModifiedResponse: true,
    auth: "data-plane-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "client-key",
    // Batch Evaluation usage is billed by this caller-owned logical fetch id
    // (ADR-0033); retries with the same key must not double-charge.
    idempotency: "required",
    errors: [
      "UNAUTHORIZED",
      "CREDENTIAL_REVOKED",
      "INSUFFICIENT_SCOPES",
      "APP_MISMATCH",
      "ORIGIN_NOT_ALLOWED",
      "VALIDATION_ERROR",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
] as const satisfies readonly ApiRouteContract[];
