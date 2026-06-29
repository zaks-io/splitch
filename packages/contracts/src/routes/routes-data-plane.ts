import {
  DataPlaneEvaluateRequestSchema,
  DataPlaneEvaluateResponseSchema,
} from "../wire-envelopes-core.js";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route.js";

/**
 * Public data-plane SDK endpoints on the Evaluation Worker. These carry NO
 * `:appId` path param — `app_id` is the credential's alone (ADR-0018), so the
 * tenant-crossing footgun is absent at the route level. They are NOT MCP tools.
 *
 * - evaluate: Client Key only; fires an Exposure as a structural side effect.
 * - verify:   mixed Client Key | API Key (data-plane-key, ADR-0037); fires no
 *             Exposure; reuses the evaluate request + bare wire response shape
 *             (the SDK synthesizes ResolutionDetails from it).
 *
 * Endpoint canon: docs/spec/sdk/public-evaluate-endpoint.md, verify-endpoint.md.
 */

const OWNER = "evaluation-api" as const;

export const dataPlaneRoutes: readonly ApiRouteContract[] = [
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
    idempotency: "none",
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
    operationId: "sdk_verify",
    owner: OWNER,
    method: "POST",
    path: "/api/sdk/verify",
    summary: "Verify setup under a Client Key or API Key (no Exposure; tiered reason).",
    request: { body: DataPlaneEvaluateRequestSchema },
    response: DataPlaneEvaluateResponseSchema,
    auth: "data-plane-key",
    rateLimit: "client-key",
    idempotency: "none",
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
];
