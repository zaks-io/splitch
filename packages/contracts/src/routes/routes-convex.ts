import { z } from "zod";
import {
  CONVEX_SERVER_EXPOSURE_MAX_BODY_BYTES,
  ConvexConfigSnapshotSchema,
  ConvexInstallationCreateRequestSchema,
  ConvexInstallationListResponseSchema,
  ConvexInstallationSchema,
  ConvexInstallationStatusSchema,
  ConvexSecretRotationRequestSchema,
  ConvexSecretRotationResponseSchema,
  ConvexServerExposureRequestSchema,
  ConvexServerExposureResponseSchema,
} from "../convex-integration";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { EnvParams } from "./route-shapes";

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

/**
 * Reading and revoking an Environment's Convex installation is administration,
 * so these routes sit on the operator door. The existing `/api/integrations`
 * routes stay on the data plane for the Convex Component.
 */
const PANEL_BASE = "/apps/:appId/envs/:environmentId/integrations/convex/installations";
const PanelInstallationParams = EnvParams.extend({ installationId: z.uuid() });
const panelErrors = ["APP_NOT_FOUND", "FORBIDDEN", "INSUFFICIENT_SCOPES"] as const;

export const convexRoutes = [
  defineApiRoute({
    operationId: "convex_installations_create",
    owner: OWNER,
    method: "POST",
    path: "/api/integrations/convex/installations",
    summary: "Install one Convex Component for the API Key's Environment.",
    request: { body: ConvexInstallationCreateRequestSchema },
    response: ConvexInstallationSchema,
    auth: "api-key",
    // The mounted API Key is the Component's only credential: it authenticates
    // evaluation and Metric Event delivery alike. Delivery runs after the
    // caller's Mutation has committed, so an evaluate-only Key would let
    // install and every `track()` report success and then send each Metric
    // Event terminal, where nobody is looking. Requiring both scopes at
    // install refuses that Key at the one moment a human is watching.
    scopes: ["data-plane:evaluate", "data-plane:write"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [...commonErrors, "IDEMPOTENCY_KEY_CONFLICT"],
  }),
  defineApiRoute({
    operationId: "convex_installations_get",
    owner: OWNER,
    method: "GET",
    path: "/api/integrations/convex/installations/:installationId",
    summary: "Read Convex integration delivery health without secrets.",
    request: { params: z.object({ installationId: z.uuid() }) },
    response: ConvexInstallationStatusSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [...commonErrors, "CONVEX_INSTALLATION_NOT_FOUND"],
  }),
  defineApiRoute({
    operationId: "convex_installations_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/api/integrations/convex/installations/:installationId",
    summary: "Revoke a Convex integration and suppress pending deliveries.",
    request: { params: z.object({ installationId: z.uuid() }) },
    response: z.null(),
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: commonErrors,
  }),
  defineApiRoute({
    operationId: "convex_secret_rotations_create",
    owner: OWNER,
    method: "POST",
    path: "/api/integrations/convex/installations/:installationId/secret-rotations",
    summary: "Rotate the outbound Convex webhook secret.",
    request: {
      params: z.object({ installationId: z.uuid() }),
      body: ConvexSecretRotationRequestSchema,
    },
    response: ConvexSecretRotationResponseSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [...commonErrors, "CONVEX_INSTALLATION_NOT_FOUND", "IDEMPOTENCY_KEY_CONFLICT"],
  }),
  defineApiRoute({
    operationId: "convex_snapshot_get",
    owner: OWNER,
    method: "GET",
    path: "/api/integrations/convex/snapshot",
    summary: "Pull the complete server configuration for the API Key's Environment.",
    request: {},
    response: ConvexConfigSnapshotSchema,
    notModifiedResponse: true,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: commonErrors,
  }),
  defineApiRoute({
    operationId: "convex_exposures_create",
    owner: "evaluation-api",
    method: "POST",
    path: "/api/integrations/convex/exposures",
    summary: "Verify and ingest locally evaluated Convex Exposures.",
    request: { body: ConvexServerExposureRequestSchema },
    response: ConvexServerExposureResponseSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    rawBodyByteLimit: {
      maxBytes: CONVEX_SERVER_EXPOSURE_MAX_BODY_BYTES,
      error: {
        code: "VALIDATION_ERROR",
        message: `Convex Exposure body exceeds ${CONVEX_SERVER_EXPOSURE_MAX_BODY_BYTES} UTF-8 bytes`,
        details: {
          issues: [
            {
              path: ["body"],
              message: `body must be at most ${CONVEX_SERVER_EXPOSURE_MAX_BODY_BYTES} UTF-8 bytes`,
            },
          ],
        },
      },
    },
    errors: [...commonErrors, "CONVEX_INSTALLATION_NOT_FOUND", "EVENT_ID_CONFLICT"],
  }),
  defineApiRoute({
    operationId: "convex_installations_list",
    owner: OWNER,
    method: "GET",
    path: PANEL_BASE,
    summary: "List Convex installations and their delivery health for this Environment.",
    request: { params: EnvParams },
    response: ConvexInstallationListResponseSchema,
    auth: "control-plane-token",
    rateLimit: "control-plane-actor",
    idempotency: "none",
    errors: panelErrors,
  }),
  defineApiRoute({
    operationId: "convex_installations_revoke",
    owner: OWNER,
    method: "DELETE",
    path: `${PANEL_BASE}/:installationId`,
    summary: "Revoke a Convex integration and suppress pending deliveries.",
    request: { params: PanelInstallationParams },
    response: z.null(),
    auth: "control-plane-token",
    rateLimit: "control-plane-actor",
    idempotency: "none",
    errors: [...panelErrors, "CONVEX_INSTALLATION_NOT_FOUND"],
  }),
] as const satisfies readonly ApiRouteContract[];
