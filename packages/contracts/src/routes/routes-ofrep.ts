import { type ApiRouteContract, defineApiRoute, errorResponseSchemaFor, z } from "../openapi-route";
import { exposureWriteClosed, readOnlyClosed } from "../route-effects";
import {
  OfrepBulkEvaluationFailureSchema,
  OfrepBulkEvaluationRequestSchema,
  OfrepBulkEvaluationSuccessSchema,
  OfrepEvaluationFailureSchema,
  OfrepEvaluationRequestRuntimeSchema,
  OfrepEvaluationRequestSchema,
  OfrepEvaluationSuccessSchema,
  OfrepFlagKeyParamsSchema,
  OfrepGeneralErrorSchema,
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

/** Body-limit VALIDATION_ERROR plus OFREP evaluation/request failures. */
const OfrepSingleStatus400Schema = z.union([
  errorResponseSchemaFor("VALIDATION_ERROR"),
  OfrepEvaluationFailureSchema,
]);

const OfrepBulkStatus400Schema = z.union([
  errorResponseSchemaFor("VALIDATION_ERROR"),
  errorResponseSchemaFor("UNSUPPORTED_OBJECT_KEY"),
  OfrepBulkEvaluationFailureSchema,
]);

export const ofrepRoutes = [
  defineApiRoute({
    operationId: "ofrep_evaluate",
    owner: OWNER,
    method: "POST",
    path: "/ofrep/v1/evaluate/flags/:key",
    summary: "OFREP single-Flag evaluation (Exposure-bearing).",
    request: {
      params: OfrepFlagKeyParamsSchema,
      body: OfrepEvaluationRequestSchema,
      runtimeBody: OfrepEvaluationRequestRuntimeSchema,
    },
    response: OfrepEvaluationSuccessSchema,
    auth: "data-plane-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "client-key",
    // OFREP clients may omit this header; the handler mints a per-request key.
    idempotency: "optional",
    effects: exposureWriteClosed,
    errors: [...OFREP_AUTH_ERRORS, "FLAG_NOT_FOUND"],
    errorResponseSchemas: {
      400: OfrepSingleStatus400Schema,
      404: OfrepEvaluationFailureSchema,
      500: OfrepGeneralErrorSchema,
    },
  }),
  defineApiRoute({
    operationId: "ofrep_evaluate_bulk",
    owner: OWNER,
    method: "POST",
    path: "/ofrep/v1/evaluate/flags",
    summary: "OFREP bulk Flag evaluation (non-exposing prefetch).",
    request: {
      body: OfrepBulkEvaluationRequestSchema,
      runtimeBody: OfrepEvaluationRequestRuntimeSchema,
    },
    response: OfrepBulkEvaluationSuccessSchema,
    notModifiedResponse: true,
    auth: "data-plane-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "client-key",
    idempotency: "optional",
    effects: readOnlyClosed,
    errors: [...OFREP_AUTH_ERRORS, "UNSUPPORTED_OBJECT_KEY"],
    errorResponseSchemas: {
      400: OfrepBulkStatus400Schema,
      500: OfrepGeneralErrorSchema,
    },
  }),
] as const satisfies readonly ApiRouteContract[];
