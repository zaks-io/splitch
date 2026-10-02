import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  OfrepBulkEvaluationRequestSchema,
  OfrepBulkEvaluationSuccessSchema,
  OfrepEvaluationRequestSchema,
  OfrepEvaluationSuccessSchema,
  OfrepFlagKeyParamsSchema,
} from "../wire-envelopes-core";

/**
 * OFREP Core endpoints on the Evaluation Worker. Same credential door as the
 * rest of the data plane: Environment comes from the Client Key or API Key.
 */

const OWNER = "evaluation-api" as const;

const OFREP_AUTH_ERRORS = [
  "UNAUTHORIZED",
  "CREDENTIAL_REVOKED",
  "INSUFFICIENT_SCOPES",
  "ORIGIN_NOT_ALLOWED",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
] as const;

export const ofrepRoutes = [
  defineApiRoute({
    operationId: "ofrep_evaluate",
    owner: OWNER,
    method: "POST",
    path: "/ofrep/v1/evaluate/flags/:key",
    summary: "OFREP single-Flag evaluation (Exposure-bearing).",
    request: { params: OfrepFlagKeyParamsSchema, body: OfrepEvaluationRequestSchema },
    response: OfrepEvaluationSuccessSchema,
    auth: "data-plane-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "client-key",
    // OFREP clients may omit this header; the handler mints a per-request key.
    idempotency: "optional",
    errors: [...OFREP_AUTH_ERRORS, "FLAG_NOT_FOUND"],
  }),
  defineApiRoute({
    operationId: "ofrep_evaluate_bulk",
    owner: OWNER,
    method: "POST",
    path: "/ofrep/v1/evaluate/flags",
    summary: "OFREP bulk Flag evaluation (non-exposing prefetch).",
    request: { body: OfrepBulkEvaluationRequestSchema },
    response: OfrepBulkEvaluationSuccessSchema,
    notModifiedResponse: true,
    auth: "data-plane-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "client-key",
    idempotency: "optional",
    errors: [...OFREP_AUTH_ERRORS, "UNSUPPORTED_OBJECT_KEY"],
  }),
] as const satisfies readonly ApiRouteContract[];
