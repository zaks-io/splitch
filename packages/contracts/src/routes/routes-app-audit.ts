import { AppAuditListQuerySchema, AppAuditListResponseSchema } from "../app-audit";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { readOnlyClosed } from "../route-effects";
import { AppParams } from "./route-shapes";

export const appAuditRoutes = [
  defineApiRoute({
    operationId: "app_audit_list",
    owner: "analysis-api",
    method: "GET",
    path: "/apps/:appId/audit",
    summary: "List App audit events. Requires live App admin membership and credential scope.",
    request: { params: AppParams, query: AppAuditListQuerySchema },
    response: AppAuditListResponseSchema,
    auth: "control-plane-token",
    permission: "read",
    rateLimit: "control-plane-actor",
    effects: readOnlyClosed,
    idempotency: "none",
    errors: [
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "INSUFFICIENT_SCOPES",
      "VALIDATION_ERROR",
      "INVALID_PAGINATION",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_SERVER_ERROR",
    ],
  }),
] as const satisfies readonly ApiRouteContract[];
