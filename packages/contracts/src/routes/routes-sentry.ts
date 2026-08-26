import { z } from "zod";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  SentryInstallationCreateRequestSchema,
  SentryInstallationCreateResponseSchema,
  SentryInstallationListResponseSchema,
  SentryInstallationStatusSchema,
  SentrySecretRotationRequestSchema,
  SentrySecretRotationResponseSchema,
} from "../sentry-integration";
import { OrgParams } from "./route-shapes";

/**
 * Wiring an Organization's Flag changes into a Sentry organization is
 * administration, not data-plane traffic, so these sit on the operator door
 * beside the Organization's own routes rather than on the edge. That is what
 * lets the Control Panel reach them over the binding protocol, whose delegation
 * claim must name the resource it acts on.
 *
 * Organization-addressed, not Environment-addressed: Sentry keeps one signing
 * secret per provider type per organization, so two Environments wiring up the
 * same Sentry org would each mint a secret and the second would silently
 * invalidate the first.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;
const BASE = "/orgs/:orgId/integrations/sentry/installations";
const InstallationParams = OrgParams.extend({ installationId: z.uuid() });
const commonErrors = ["FORBIDDEN", "INSUFFICIENT_SCOPES"] as const;

export const sentryRoutes = [
  defineApiRoute({
    operationId: "sentry_installations_list",
    owner: OWNER,
    method: "GET",
    path: BASE,
    summary: "List Sentry change-tracking installations and their delivery health.",
    request: { params: OrgParams },
    response: SentryInstallationListResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: commonErrors,
  }),
  defineApiRoute({
    operationId: "sentry_installations_create",
    owner: OWNER,
    method: "POST",
    path: BASE,
    summary: "Send this Organization's Flag changes to a Sentry organization.",
    request: { params: OrgParams, body: SentryInstallationCreateRequestSchema },
    response: SentryInstallationCreateResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      ...commonErrors,
      "VALIDATION_ERROR",
      "IDEMPOTENCY_KEY_CONFLICT",
      "SENTRY_INSTALLATION_CONFLICT",
    ],
  }),
  defineApiRoute({
    operationId: "sentry_installations_get",
    owner: OWNER,
    method: "GET",
    path: `${BASE}/:installationId`,
    summary: "Read Sentry change-tracking delivery health without secrets.",
    request: { params: InstallationParams },
    response: SentryInstallationStatusSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [...commonErrors, "SENTRY_INSTALLATION_NOT_FOUND"],
  }),
  defineApiRoute({
    operationId: "sentry_installations_delete",
    owner: OWNER,
    method: "DELETE",
    path: `${BASE}/:installationId`,
    summary: "Revoke a Sentry integration and stop change delivery.",
    request: { params: InstallationParams },
    response: z.null(),
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: commonErrors,
  }),
  defineApiRoute({
    operationId: "sentry_secret_rotations_create",
    owner: OWNER,
    method: "POST",
    path: `${BASE}/:installationId/secret-rotations`,
    summary: "Rotate the Sentry webhook signing secret.",
    request: { params: InstallationParams, body: SentrySecretRotationRequestSchema },
    response: SentrySecretRotationResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [...commonErrors, "SENTRY_INSTALLATION_NOT_FOUND", "IDEMPOTENCY_KEY_CONFLICT"],
  }),
] as const satisfies readonly ApiRouteContract[];
