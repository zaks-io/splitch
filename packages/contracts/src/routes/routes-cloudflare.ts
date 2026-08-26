import { z } from "zod";
import {
  CLOUDFLARE_SERVER_EXPOSURE_MAX_BODY_BYTES,
  CloudflareInstallationCreateRequestSchema,
  CloudflareInstallationListResponseSchema,
  CloudflareInstallationSchema,
  CloudflareInstallationStatusSchema,
  CloudflareServerExposureRequestSchema,
  CloudflareServerExposureResponseSchema,
} from "../cloudflare-integration";
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
 * Reading and revoking an Environment's Cloudflare installation is
 * administration, so these routes sit on the operator door. The existing
 * `/api/integrations` routes stay on the data plane for the customer Worker.
 */
const PANEL_BASE = "/apps/:appId/envs/:environmentId/integrations/cloudflare/installations";
const PanelInstallationParams = EnvParams.extend({ installationId: z.uuid() });
const panelErrors = ["APP_NOT_FOUND", "FORBIDDEN", "INSUFFICIENT_SCOPES"] as const;

export const cloudflareRoutes = [
  defineApiRoute({
    operationId: "cloudflare_installations_create",
    owner: "control-plane-api",
    method: "POST",
    path: "/api/integrations/cloudflare/installations",
    summary: "Install one Cloudflare integration Worker for the API Key's Environment.",
    request: { body: CloudflareInstallationCreateRequestSchema },
    response: CloudflareInstallationSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [...commonErrors, "IDEMPOTENCY_KEY_CONFLICT"],
  }),
  defineApiRoute({
    operationId: "cloudflare_installations_get",
    owner: "control-plane-api",
    method: "GET",
    path: "/api/integrations/cloudflare/installations/:installationId",
    summary: "Read Cloudflare integration delivery health without secrets.",
    request: { params: z.object({ installationId: z.uuid() }) },
    response: CloudflareInstallationStatusSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: [...commonErrors, "CLOUDFLARE_INSTALLATION_NOT_FOUND"],
  }),
  defineApiRoute({
    operationId: "cloudflare_installations_delete",
    owner: "control-plane-api",
    method: "DELETE",
    path: "/api/integrations/cloudflare/installations/:installationId",
    summary: "Revoke a Cloudflare integration and suppress pending deliveries.",
    request: { params: z.object({ installationId: z.uuid() }) },
    response: z.null(),
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    errors: commonErrors,
  }),
  defineApiRoute({
    operationId: "cloudflare_exposures_create",
    owner: "evaluation-api",
    method: "POST",
    path: "/api/integrations/cloudflare/exposures",
    summary: "Verify and ingest locally evaluated Cloudflare Exposures.",
    request: { body: CloudflareServerExposureRequestSchema },
    response: CloudflareServerExposureResponseSchema,
    auth: "api-key",
    scopes: ["data-plane:evaluate"],
    rateLimit: "api-key",
    idempotency: "none",
    rawBodyByteLimit: {
      maxBytes: CLOUDFLARE_SERVER_EXPOSURE_MAX_BODY_BYTES,
      error: {
        code: "VALIDATION_ERROR",
        message: `Cloudflare Exposure body exceeds ${CLOUDFLARE_SERVER_EXPOSURE_MAX_BODY_BYTES} UTF-8 bytes`,
        details: {
          issues: [
            {
              path: ["body"],
              message: `body must be at most ${CLOUDFLARE_SERVER_EXPOSURE_MAX_BODY_BYTES} UTF-8 bytes`,
            },
          ],
        },
      },
    },
    errors: [...commonErrors, "CLOUDFLARE_INSTALLATION_NOT_FOUND", "EVENT_ID_CONFLICT"],
  }),
  defineApiRoute({
    operationId: "cloudflare_panel_installations_list",
    owner: OWNER,
    method: "GET",
    path: PANEL_BASE,
    summary: "List Cloudflare installations and their delivery health for this Environment.",
    request: { params: EnvParams },
    response: CloudflareInstallationListResponseSchema,
    auth: "control-plane-token",
    rateLimit: "control-plane-actor",
    idempotency: "none",
    errors: panelErrors,
  }),
  defineApiRoute({
    operationId: "cloudflare_panel_installations_delete",
    owner: OWNER,
    method: "DELETE",
    path: `${PANEL_BASE}/:installationId`,
    summary: "Revoke a Cloudflare integration and suppress pending deliveries.",
    request: { params: PanelInstallationParams },
    response: z.null(),
    auth: "control-plane-token",
    rateLimit: "control-plane-actor",
    idempotency: "none",
    errors: [...panelErrors, "CLOUDFLARE_INSTALLATION_NOT_FOUND"],
  }),
] as const satisfies readonly ApiRouteContract[];
