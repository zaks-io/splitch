import { ResolutionDetailsSchema } from "../leaf-schemas-runtime";
import {
  MetricEventActivateResponseSchema,
  MetricEventTrackRequestSchema,
  MetricEventTrackResponseSchema,
} from "../metric-event";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  CachedEvaluationTelemetryRequestSchema,
  CachedEvaluationTelemetryResponseSchema,
  DataPlaneEvaluateRequestSchema,
  DataPlaneEvaluateResponseSchema,
  EvaluateAllRequestSchema,
  EvaluateAllResponseSchema,
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  ExposureBatchRequestSchema,
  ExposureBatchResponseSchema,
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
 * - exposures:    mixed Client Key | API Key; batched Exposure Ticket redemption
 *                 (ADR-0048); seals canonical Exposures and deferred Assignment Store
 *                 puts; retry identity is per-item `exposureId`.
 *
 * Endpoint canon: docs/spec/sdk/public-evaluate-endpoint.md,
 * exposure-accessor.md, verify-endpoint.md, evaluate-all-endpoint.md,
 * exposures-endpoint.md.
 */

const OWNER = "evaluation-api" as const;

export const dataPlaneRoutes = [
  defineApiRoute({
    operationId: "sdk_activate",
    owner: "event-ingest-api",
    method: "POST",
    path: "/api/sdk/activations",
    summary: "Submit one declared Metric Event and activate every matching live Experiment Run.",
    request: { body: MetricEventTrackRequestSchema },
    response: MetricEventActivateResponseSchema,
    auth: "data-plane-key",
    scopes: ["data-plane:write"],
    rateLimit: "client-key",
    idempotency: "none",
    errors: [
      "UNAUTHORIZED",
      "CREDENTIAL_REVOKED",
      "INSUFFICIENT_SCOPES",
      "ORIGIN_NOT_ALLOWED",
      "VALIDATION_ERROR",
      "EVENT_DEFINITION_NOT_FOUND",
      "EVENT_DEFINITION_UNPUBLISHED",
      "EVENT_SCHEMA_MISMATCH",
      "ENTITY_TYPE_MISMATCH",
      "EVENT_ID_CONFLICT",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "sdk_track",
    owner: "event-ingest-api",
    method: "POST",
    path: "/api/sdk/events",
    summary: "Submit one declared Metric Event with explicit Entity identity.",
    request: { body: MetricEventTrackRequestSchema },
    response: MetricEventTrackResponseSchema,
    auth: "data-plane-key",
    scopes: ["data-plane:write"],
    rateLimit: "client-key",
    idempotency: "none",
    errors: [
      "UNAUTHORIZED",
      "CREDENTIAL_REVOKED",
      "INSUFFICIENT_SCOPES",
      "ORIGIN_NOT_ALLOWED",
      "VALIDATION_ERROR",
      "EVENT_DEFINITION_NOT_FOUND",
      "EVENT_DEFINITION_UNPUBLISHED",
      "EVENT_SCHEMA_MISMATCH",
      "ENTITY_TYPE_MISMATCH",
      "EVENT_ID_CONFLICT",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
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
      "UNSUPPORTED_OBJECT_KEY",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  defineApiRoute({
    operationId: "sdk_exposures",
    owner: OWNER,
    method: "POST",
    path: "/api/sdk/exposures",
    summary: "Redeem Exposure Tickets in a batch (forgery-proof; deferred Assignment Store put).",
    request: { body: ExposureBatchRequestSchema },
    response: ExposureBatchResponseSchema,
    auth: "data-plane-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "client-key",
    // Retry identity is per-item exposureId (SDK-owned), not a batch Idempotency-Key.
    idempotency: "none",
    rawBodyByteLimit: {
      maxBytes: EXPOSURE_BATCH_MAX_BODY_BYTES,
      error: {
        code: "VALIDATION_ERROR",
        message: `Exposure batch body exceeds ${EXPOSURE_BATCH_MAX_BODY_BYTES} UTF-8 bytes`,
        details: {
          issues: [
            {
              path: ["body"],
              message: `body must be at most ${EXPOSURE_BATCH_MAX_BODY_BYTES} UTF-8 bytes`,
            },
          ],
        },
      },
    },
    errors: [
      "UNAUTHORIZED",
      "CREDENTIAL_REVOKED",
      "INSUFFICIENT_SCOPES",
      "ORIGIN_NOT_ALLOWED",
      "VALIDATION_ERROR",
      "EXPOSURE_TICKET_INVALID",
      "EXPOSURE_TICKET_EXPIRED",
      "EVENT_ID_CONFLICT",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_SERVER_ERROR",
    ],
  }),
] as const satisfies readonly ApiRouteContract[];
