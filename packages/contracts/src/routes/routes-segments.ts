import { z } from "@hono/zod-openapi";
import { SegmentSchema } from "../leaf-schemas-flag";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import {
  AppParams,
  CreateSegmentRequestSchema,
  PatchSegmentRequestSchema,
  SegmentParams,
} from "./route-shapes";

/**
 * Segment routes. Control Plane API Worker.
 * Endpoint canon: docs/spec/control-plane/endpoints-flag-segment.md.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

const SegmentListResponse = z.object({
  items: z.array(SegmentSchema),
  affectedEnvironmentIds: z.record(z.string(), z.array(z.string())),
});
const DeletedResponse = z.object({ deleted: z.literal(true) });

export const segmentRoutes = [
  defineApiRoute({
    operationId: "segments_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/segments",
    summary: "List Segments in an App.",
    request: { params: AppParams },
    response: SegmentListResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "segments_create",
    owner: OWNER,
    method: "POST",
    path: "/apps/:appId/segments",
    summary: "Create a Segment.",
    request: { params: AppParams, body: CreateSegmentRequestSchema },
    response: SegmentSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "optional",
    errors: ["APP_NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"],
  }),
  defineApiRoute({
    operationId: "segments_get",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/segments/:segmentId",
    summary: "Get a Segment.",
    request: { params: SegmentParams },
    response: SegmentSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["SEGMENT_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "segments_update",
    owner: OWNER,
    method: "PATCH",
    path: "/apps/:appId/segments/:segmentId",
    summary: "Update a Segment.",
    request: { params: SegmentParams, body: PatchSegmentRequestSchema },
    response: SegmentSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "optional",
    errors: [
      "SEGMENT_NOT_FOUND",
      "FORBIDDEN",
      "VALIDATION_ERROR",
      "APPROVAL_REVIEW_REQUIRED",
      "APPROVAL_REVIEW_FORBIDDEN",
      "IDEMPOTENCY_KEY_CONFLICT",
    ],
  }),
  defineApiRoute({
    operationId: "segments_delete",
    owner: OWNER,
    method: "DELETE",
    path: "/apps/:appId/segments/:segmentId",
    summary: "Delete a Segment when no mutable Flag Configuration or Experiment draft uses it.",
    request: { params: SegmentParams },
    response: DeletedResponse,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    errors: ["SEGMENT_NOT_FOUND", "FORBIDDEN", "RESOURCE_NOT_EMPTY"],
  }),
] as const satisfies readonly ApiRouteContract[];
