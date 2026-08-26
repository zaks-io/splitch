import { z } from "zod";
import {
  SentryInstallationCreateRequestSchema,
  SentryInstallationSchema,
  SentryInstallationStatusSchema,
  SentrySecretRotationRequestSchema,
  SentrySecretRotationResponseSchema,
} from "../sentry-integration";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";

const OWNER = "control-plane-api" as const;
const commonErrors = [
  "UNAUTHORIZED",
  "CREDENTIAL_REVOKED",
  "INSUFFICIENT_SCOPES",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
] as const;

export const sentryRoutes = [
  defineApiRoute({
    operationId: "sentry_installations_create",
    owner: OWNER,
    method: "POST",
    path: "/api/integrations/sentry/installations",
    summary: "Send Flag changes in the API Key's Environment to a Sentry organization.",
    request: { body: SentryInstallationCreateRequestSchema },
    response: SentryInstallationSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [...commonErrors, "IDEMPOTENCY_KEY_CONFLICT"],
  }),
  defineApiRoute({
    operationId: "sentry_installations_get",
    owner: OWNER,
    method: "GET",
    path: "/api/integrations/sentry/installations/:installationId",
    summary: "Read Sentry change-tracking delivery health without secrets.",
    request: { params: z.object({ installationId: z.uuid() }) },
    response: SentryInstallationStatusSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [...commonErrors, "SENTRY_INSTALLATION_NOT_FOUND"],
  }),
  defineApiRoute({
    operationId: "sentry_installations_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/api/integrations/sentry/installations/:installationId",
    summary: "Revoke a Sentry integration and stop change delivery.",
    request: { params: z.object({ installationId: z.uuid() }) },
    response: z.null(),
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: commonErrors,
  }),
  defineApiRoute({
    operationId: "sentry_secret_rotations_create",
    owner: OWNER,
    method: "POST",
    path: "/api/integrations/sentry/installations/:installationId/secret-rotations",
    summary: "Rotate the Sentry webhook signing secret.",
    request: {
      params: z.object({ installationId: z.uuid() }),
      body: SentrySecretRotationRequestSchema,
    },
    response: SentrySecretRotationResponseSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [...commonErrors, "SENTRY_INSTALLATION_NOT_FOUND", "IDEMPOTENCY_KEY_CONFLICT"],
  }),
] as const satisfies readonly ApiRouteContract[];
