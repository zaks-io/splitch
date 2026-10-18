import { z } from "@hono/zod-openapi";
import { AppMemberSchema, AppSchema } from "../leaf-schemas-runtime";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  ResourceDeleteModeQuerySchema,
  ResourceDeleteResponseSchema,
} from "../resource-delete-tree";
import {
  CreateAppRequestSchema,
  CreateAppResponseSchema,
  PatchAppRequestSchema,
} from "../resource-envelopes-account";
import {
  createClosed,
  deleteClosed,
  membershipRemoveClosed,
  readOnlyClosed,
  updateClosed,
} from "../route-effects";
import { listResponse } from "../wire-envelopes-core";
import {
  AddAppMemberRequestSchema,
  AppMemberParams,
  AppParams,
  OrgAppsParams,
  UpdateAppMemberRequestSchema,
} from "./route-shapes";
import { environmentRoutes, environmentSyncRoute } from "./routes-environments";

/**
 * App and Environment management routes. Split out of routes-account.ts purely
 * for file size; they share its owner, auth, and rate class, and the combined
 * `accountRoutes` list there is still the registry the surfaces derive from.
 * Endpoint canon: docs/spec/control-plane/endpoints-org-app.md.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

const AppListResponse = listResponse(AppSchema);
const AppMemberListResponse = listResponse(AppMemberSchema);
const DeletedResponse = z.object({ deleted: z.literal(true) });

export const appEnvironmentRoutes = [
  defineApiRoute({
    operationId: "apps_list",
    owner: OWNER,
    method: "GET",
    path: "/orgs/:orgId/apps",
    summary: "List the Apps in an organization.",
    request: { params: OrgAppsParams },
    response: AppListResponse,
    auth: AUTH,
    permission: "read",
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["ORGANIZATION_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "apps_create",
    owner: OWNER,
    method: "POST",
    path: "/orgs/:orgId/apps",
    summary: "Create an App (provisions dev + prod Environments and Client Keys).",
    request: { params: OrgAppsParams, body: CreateAppRequestSchema },
    response: CreateAppResponseSchema,
    auth: AUTH,
    permission: "write",
    rateLimit: RATE,
    idempotency: "optional",
    effects: createClosed,
    errors: ["ORGANIZATION_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR", "IDEMPOTENCY_KEY_CONFLICT"],
  }),
  defineApiRoute({
    operationId: "apps_get",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId",
    summary: "Get one App.",
    request: { params: AppParams },
    response: AppSchema,
    auth: AUTH,
    permission: "read",
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "apps_update",
    owner: OWNER,
    method: "PATCH",
    path: "/apps/:appId",
    summary: "Rename an App or change its URL slug.",
    request: { params: AppParams, body: PatchAppRequestSchema },
    response: AppSchema,
    auth: AUTH,
    permission: "write",
    rateLimit: RATE,
    idempotency: "none",
    effects: updateClosed,
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "apps_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/apps/:appId",
    summary:
      "Delete an App. Dry-run mode lists every blocker with IDs and remove commands; force mode cascades non-gated children and stops with pending Approval Request IDs when Policy requires Review. Blocked while any Experiment is running.",
    request: { params: AppParams, query: ResourceDeleteModeQuerySchema },
    response: ResourceDeleteResponseSchema,
    auth: AUTH,
    permission: "delete",
    rateLimit: RATE,
    idempotency: "none",
    effects: deleteClosed,
    errors: [
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "EXPERIMENT_RUNNING",
      "RESOURCE_NOT_EMPTY",
      "VALIDATION_ERROR",
    ],
  }),
  ...environmentRoutes,
  /**
   * App membership is managed HERE, under the App, not under the Organization
   * (screen-inventory.md Settings). Appended at the end of this list on purpose:
   * `control-plane-client-app.ts` selects SDK routes by index, so inserting them
   * mid-list would silently re-point every later selection.
   */
  defineApiRoute({
    operationId: "app_members_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/members",
    summary: "List the members of an App and their App roles.",
    request: { params: AppParams },
    response: AppMemberListResponse,
    auth: AUTH,
    permission: "read",
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "SERVICE_UNAVAILABLE"],
  }),
  defineApiRoute({
    operationId: "app_members_add",
    audit: "app",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/members",
    summary: "Grant a user a role on an App.",
    request: { params: AppParams, body: AddAppMemberRequestSchema },
    response: AppMemberSchema,
    auth: AUTH,
    permission: "members",
    rateLimit: RATE,
    idempotency: "none",
    effects: createClosed,
    errors: [
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "USER_NOT_FOUND",
      "MEMBERSHIP_CONFLICT",
      "SERVICE_UNAVAILABLE",
      "VALIDATION_ERROR",
    ],
  }),
  defineApiRoute({
    operationId: "app_members_update",
    audit: "app",
    owner: OWNER,
    method: "PATCH",
    path: "/apps/:appId/members/:userId",
    summary: "Change a member's App role.",
    request: { params: AppMemberParams, body: UpdateAppMemberRequestSchema },
    response: AppMemberSchema,
    auth: AUTH,
    permission: "members",
    rateLimit: RATE,
    idempotency: "none",
    effects: updateClosed,
    errors: [
      "APP_NOT_FOUND",
      "USER_NOT_FOUND",
      "FORBIDDEN",
      "LAST_OWNER_REQUIRED",
      "SERVICE_UNAVAILABLE",
      "VALIDATION_ERROR",
    ],
  }),
  defineApiRoute({
    operationId: "app_members_remove",
    audit: "app",
    owner: OWNER,
    method: "DELETE",
    path: "/apps/:appId/members/:userId",
    summary: "Revoke a user's access to an App (rejected if removing the last owner).",
    request: { params: AppMemberParams },
    response: DeletedResponse,
    auth: AUTH,
    permission: "members",
    rateLimit: RATE,
    idempotency: "none",
    effects: membershipRemoveClosed,
    errors: [
      "APP_NOT_FOUND",
      "USER_NOT_FOUND",
      "FORBIDDEN",
      "LAST_OWNER_REQUIRED",
      "SERVICE_UNAVAILABLE",
    ],
  }),
  environmentSyncRoute,
] as const satisfies readonly ApiRouteContract[];
