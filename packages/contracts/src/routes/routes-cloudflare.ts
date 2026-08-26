import { z } from "zod";
import {
  CLOUDFLARE_SERVER_EXPOSURE_MAX_BODY_BYTES,
  CloudflareInstallationCreateRequestSchema,
  CloudflareInstallationSchema,
  CloudflareInstallationStatusSchema,
  CloudflareServerExposureRequestSchema,
  CloudflareServerExposureResponseSchema,
} from "../cloudflare-integration";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";

const commonErrors = [
  "UNAUTHORIZED",
  "CREDENTIAL_REVOKED",
  "INSUFFICIENT_SCOPES",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
] as const;

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
] as const satisfies readonly ApiRouteContract[];
