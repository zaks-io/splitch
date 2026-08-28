import { z } from "@hono/zod-openapi";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { PersistedIdentifierSchema } from "../persisted-field-limits";
import { AppParams, OrgParams, PrivacyRequestParams } from "./route-shapes";

/**
 * Privacy request intake: User/Org/App exports, User deletion, Entity data-subject
 * export/delete, and request status. Control Plane API Worker. Every call writes a
 * privacy_requests D1 row + audit event.
 * Endpoint canon: docs/spec/control-plane/endpoints-privacy-data.md.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

// PrivacyRequest / PrivacyJob have no resource envelope yet; author the minimal
// wire shapes from primitives here (one concern, this file) per the spec table.
const PrivacyRequestSchema = z.object({
  requestId: z.string(),
  organizationId: z.string(),
  appId: z.string().nullable(),
  requestType: z.enum([
    "access",
    "export",
    "correct",
    "delete",
    "opt_out_sale_share",
    "limit_sensitive",
  ]),
  subjectType: z.enum(["user", "organization", "app", "entity"]),
  status: z.enum(["received", "verifying", "processing", "completed", "denied"]),
  receivedAt: z.string(),
});
const PrivacyJobSchema = z.object({
  jobId: z.string(),
  requestId: z.string(),
  kind: z.enum(["export", "delete"]),
  status: z.enum(["queued", "running", "completed", "failed"]),
});
const PrivacyResponseSchema = z.object({
  request: PrivacyRequestSchema,
  job: PrivacyJobSchema,
});
const PrivacyStatusResponseSchema = z.object({
  request: PrivacyRequestSchema,
  job: PrivacyJobSchema.nullable(),
});

// Entity export/delete carry the raw Targeting Key; the Worker hashes it server-side.
const EntityPrivacyRequestSchema = z
  .object({
    idType: PersistedIdentifierSchema,
    targetingKey: PersistedIdentifierSchema,
  })
  .strict();

export const privacyRoutes = [
  defineApiRoute({
    operationId: "current_user_privacy_export",
    owner: OWNER,
    method: "POST",
    path: "/users/me/privacy/export",
    summary: "Export the authenticated User's data.",
    response: PrivacyResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["UNAUTHORIZED", "SERVICE_UNAVAILABLE"],
  }),
  defineApiRoute({
    operationId: "current_user_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/users/me",
    summary: "Request deletion of the authenticated User.",
    response: PrivacyResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["UNAUTHORIZED", "LAST_OWNER_REQUIRED", "SERVICE_UNAVAILABLE"],
  }),
  defineApiRoute({
    operationId: "organization_privacy_export",
    owner: OWNER,
    method: "POST",
    path: "/orgs/:orgId/privacy/export",
    summary: "Export an Organization's data.",
    request: { params: OrgParams },
    response: PrivacyResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["ORGANIZATION_NOT_FOUND", "FORBIDDEN", "SERVICE_UNAVAILABLE"],
  }),
  defineApiRoute({
    operationId: "app_privacy_export",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/privacy/export",
    summary: "Export an App's data.",
    request: { params: AppParams },
    response: PrivacyResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "SERVICE_UNAVAILABLE"],
  }),
  defineApiRoute({
    operationId: "entity_privacy_export",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/privacy/entities/export",
    summary: "Export an Entity's data-subject records (Targeting Key hashed server-side).",
    request: { params: AppParams, body: EntityPrivacyRequestSchema },
    response: PrivacyResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR", "SERVICE_UNAVAILABLE"],
  }),
  defineApiRoute({
    operationId: "entity_privacy_delete",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/privacy/entities/delete",
    summary: "Delete an Entity's data (tombstones + queued physical purge).",
    request: { params: AppParams, body: EntityPrivacyRequestSchema },
    response: PrivacyResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR", "SERVICE_UNAVAILABLE"],
  }),
  defineApiRoute({
    operationId: "privacy_requests_get",
    owner: OWNER,
    method: "GET",
    path: "/privacy/requests/:requestId",
    summary: "Get a privacy request's status (and its job, if any).",
    request: { params: PrivacyRequestParams },
    response: PrivacyStatusResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["PRIVACY_JOB_NOT_FOUND", "FORBIDDEN", "SERVICE_UNAVAILABLE"],
  }),
] as const satisfies readonly ApiRouteContract[];
