import { z } from "@hono/zod-openapi";
import { EnvironmentSchema } from "../leaf-schemas-runtime";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  CreateEnvironmentResponseSchema,
  SyncEnvironmentResponseSchema,
} from "../resource-envelopes-account";
import { createClosed, deleteClosed, readOnlyClosed, updateClosed } from "../route-effects";
import { listResponse } from "../wire-envelopes-core";
import {
  AppParams,
  CreateEnvironmentRequestSchema,
  EnvParams,
  PatchEnvironmentRequestSchema,
  SyncEnvironmentRequestSchema,
} from "./route-shapes";

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;
const EnvListResponse = listResponse(EnvironmentSchema);
const DeletedResponse = z.object({ deleted: z.literal(true) });

export const environmentRoutes = [
  defineApiRoute({
    operationId: "environments_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/envs",
    summary: "List an App's Environments.",
    request: { params: AppParams },
    response: EnvListResponse,
    auth: AUTH,
    permission: "read",
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "environments_create",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/envs",
    summary:
      "Create an Environment and its Client Key. A Temporary Environment copies a source and expires within seven days.",
    request: { params: AppParams, body: CreateEnvironmentRequestSchema },
    response: CreateEnvironmentResponseSchema,
    auth: AUTH,
    permission: "write",
    rateLimit: RATE,
    idempotency: "none",
    effects: createClosed,
    errors: [
      "ENVIRONMENT_NOT_FOUND",
      "ENVIRONMENT_KIND_UNSUPPORTED",
      "TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED",
      "SYNC_LIMIT_EXCEEDED",
      "ENVIRONMENT_SYNC_INCOMPLETE",
      "SLUG_CONFLICT",
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "VALIDATION_ERROR",
    ],
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
    permission: "read",
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
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
    permission: "write",
    rateLimit: RATE,
    idempotency: "none",
    effects: updateClosed,
    errors: [
      "ENVIRONMENT_NOT_FOUND",
      "ENVIRONMENT_EXPIRED",
      "ENVIRONMENT_KIND_UNSUPPORTED",
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "VALIDATION_ERROR",
    ],
  }),
  defineApiRoute({
    operationId: "environments_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/apps/:appId/envs/:environmentId",
    summary:
      "Delete an Environment. Temporary Environments tear down immediately; permanent Environments retain running, non-empty and last-permanent-Environment guards.",
    request: { params: EnvParams },
    response: DeletedResponse,
    auth: AUTH,
    permission: "delete",
    rateLimit: RATE,
    idempotency: "none",
    effects: deleteClosed,
    errors: [
      "ENVIRONMENT_NOT_FOUND",
      "SERVICE_UNAVAILABLE",
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "EXPERIMENT_RUNNING",
      "LAST_ENVIRONMENT_REQUIRED",
      "RESOURCE_NOT_EMPTY",
    ],
  }),
] as const satisfies readonly ApiRouteContract[];

// Appended after App membership routes to preserve typed SDK route indices.
export const environmentSyncRoute = defineApiRoute({
  operationId: "environments_sync",
  owner: OWNER,
  method: "POST",
  path: "/apps/:appId/envs/:environmentId/sync",
  summary:
    "Sync every Flag Configuration from a source Environment into a Temporary Environment, including salts and excluding live Runs. Retry an incomplete Sync to converge.",
  request: { params: EnvParams, body: SyncEnvironmentRequestSchema },
  response: SyncEnvironmentResponseSchema,
  auth: AUTH,
  permission: "write",
  rateLimit: RATE,
  idempotency: "none",
  effects: updateClosed,
  errors: [
    "APP_NOT_FOUND",
    "ENVIRONMENT_NOT_FOUND",
    "FORBIDDEN",
    "VALIDATION_ERROR",
    "ENVIRONMENT_EXPIRED",
    "ENVIRONMENT_KIND_UNSUPPORTED",
    "SYNC_LIMIT_EXCEEDED",
    "ENVIRONMENT_SYNC_INCOMPLETE",
  ],
});
