import { z } from "@hono/zod-openapi";
import { AppSchema, EnvironmentSchema } from "../leaf-schemas-runtime";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  CreateAppRequestSchema,
  CreateAppResponseSchema,
  PatchAppRequestSchema,
} from "../resource-envelopes-account";
import {
  AppParams,
  CreateEnvironmentRequestSchema,
  EnvParams,
  OrgAppsParams,
  PatchEnvironmentRequestSchema,
} from "./route-shapes";

/**
 * App and Environment management routes. Split out of routes-account.ts purely
 * for file size; they share its owner, auth, and rate class, and the combined
 * `accountRoutes` list there is still the registry the surfaces derive from.
 * Endpoint canon: docs/spec/control-plane/endpoints-org-app.md.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

const AppListResponse = z.object({ items: z.array(AppSchema) });
const EnvListResponse = z.object({ items: z.array(EnvironmentSchema) });
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
    rateLimit: RATE,
    idempotency: "none",
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
    rateLimit: RATE,
    idempotency: "optional",
    errors: ["ORGANIZATION_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
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
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "apps_update",
    owner: OWNER,
    method: "PATCH",
    path: "/apps/:appId",
    summary: "Rename an App.",
    request: { params: AppParams, body: PatchAppRequestSchema },
    response: AppSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "apps_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/apps/:appId",
    summary: "Delete an App (blocked while any Experiment is running).",
    request: { params: AppParams },
    response: DeletedResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "EXPERIMENT_RUNNING", "RESOURCE_NOT_EMPTY"],
  }),
  defineApiRoute({
    operationId: "environments_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/envs",
    summary: "List an App's Environments.",
    request: { params: AppParams },
    response: EnvListResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "environments_create",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/envs",
    summary: "Create an Environment (auto-provisions its Client Key).",
    request: { params: AppParams, body: CreateEnvironmentRequestSchema },
    response: EnvironmentSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "environments_get",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/envs/:environmentId",
    summary: "Get one Environment (includes its inline Policy).",
    request: { params: EnvParams },
    response: EnvironmentSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "environments_update",
    owner: OWNER,
    method: "PATCH",
    path: "/apps/:appId/envs/:environmentId",
    summary: "Rename an Environment or edit its Policy.",
    request: { params: EnvParams, body: PatchEnvironmentRequestSchema },
    response: EnvironmentSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "environments_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/apps/:appId/envs/:environmentId",
    summary: "Delete an Environment (blocked if running or last Environment).",
    request: { params: EnvParams },
    response: DeletedResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: [
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "EXPERIMENT_RUNNING",
      "LAST_ENVIRONMENT_REQUIRED",
      "RESOURCE_NOT_EMPTY",
    ],
  }),
] as const satisfies readonly ApiRouteContract[];
