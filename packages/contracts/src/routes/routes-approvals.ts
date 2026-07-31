import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { paginatedResponse } from "../wire-envelopes-core";
import { AppParams, ApprovalRequestParams } from "./route-shapes";
import {
  ApprovalRequestListQuerySchema,
  ApprovalRequestSchema,
  ReviewApprovalRequestSchema,
} from "./route-shapes-approval-request";

/**
 * Approval Request reads and Review creation. The routes expose durable,
 * immutable proposals; effective staleness is computed against the live target
 * projection by the owning Worker before the response is rendered.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

const ApprovalRequestListResponseSchema = paginatedResponse(ApprovalRequestSchema);

export const approvalRoutes = [
  defineApiRoute({
    operationId: "approval_requests_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/approval-requests",
    summary: "List Approval Requests in an App.",
    request: { params: AppParams, query: ApprovalRequestListQuerySchema },
    response: ApprovalRequestListResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "INVALID_PAGINATION"],
  }),
  defineApiRoute({
    operationId: "approval_requests_get",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/approval-requests/:id",
    summary: "Get one full Approval Request projection.",
    request: { params: ApprovalRequestParams },
    response: ApprovalRequestSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APPROVAL_REQUEST_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "approval_request_reviews_create",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/approval-requests/:id/reviews",
    summary: "Review a pending Approval Request and optionally apply its proposal.",
    request: { params: ApprovalRequestParams, body: ReviewApprovalRequestSchema },
    response: ApprovalRequestSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "required",
    errors: [
      "APPROVAL_REQUEST_NOT_FOUND",
      "APPROVAL_REVIEW_FORBIDDEN",
      "APPROVAL_REQUEST_STALE",
      "APPROVAL_REQUEST_RESOLVED",
      "APPROVAL_APPLICATION_FAILED",
      "IDEMPOTENCY_KEY_CONFLICT",
      "VALIDATION_ERROR",
    ],
  }),
] as const satisfies readonly ApiRouteContract[];
