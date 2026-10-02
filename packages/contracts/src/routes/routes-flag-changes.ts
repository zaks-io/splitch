import { z } from "@hono/zod-openapi";
import {
  FlagChangeDiffSchema,
  FlagChangeActionSchema,
  FlagChangeTargetTypeSchema,
} from "../flag-change-diff";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { readOnlyClosed } from "../route-effects";
import { listResponse, PaginationQuerySchema } from "../wire-envelopes-core";
import { AppParams } from "./route-shapes";

/**
 * Flag change-log reads. Control Plane API Worker.
 * The log is the audit record (ADR-0051); these routes project stored rows.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

const InstantQuerySchema = z
  .string()
  .datetime({ offset: true })
  .describe("ISO-8601 instant with offset.");

export const FlagChangeListQuerySchema = PaginationQuerySchema.extend({
  from: InstantQuerySchema.optional(),
  to: InstantQuerySchema.optional(),
  environmentId: z.string().min(1).optional(),
  fromEnvironmentId: z.string().min(1).optional(),
  toEnvironmentId: z.string().min(1).optional(),
  flagId: z.string().min(1).optional(),
});

export const FlagChangeExportQuerySchema = FlagChangeListQuerySchema.extend({
  from: InstantQuerySchema,
  to: InstantQuerySchema,
  format: z.enum(["json", "unified"]).default("json"),
});

export const FlagChangeEntrySchema = z
  .object({
    seq: z.number().int().positive(),
    appId: z.string(),
    environmentId: z.string().nullable(),
    flagId: z.string(),
    flagKey: z.string(),
    action: FlagChangeActionSchema,
    targetType: FlagChangeTargetTypeSchema,
    actorRef: z.string().nullable(),
    actorVia: z.string().nullable(),
    changedAt: z.string(),
    diff: FlagChangeDiffSchema,
  })
  .strict();

export const FlagChangeListResponseSchema = listResponse(FlagChangeEntrySchema);
export const FlagChangeExportResponseSchema = FlagChangeListResponseSchema.extend({
  unifiedDiff: z.string(),
  format: z.enum(["json", "unified"]),
});

const READ_ERRORS = [
  "APP_NOT_FOUND",
  "FORBIDDEN",
  "VALIDATION_ERROR",
  "INVALID_PAGINATION",
] as const;

export const flagChangeRoutes = [
  defineApiRoute({
    operationId: "flag_changes_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/flag-changes",
    summary:
      "List Flag change-log entries with a structured before/after diff computed from stored records.",
    request: { params: AppParams, query: FlagChangeListQuerySchema },
    response: FlagChangeListResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    effects: readOnlyClosed,
    idempotency: "none",
    errors: [...READ_ERRORS],
  }),
  defineApiRoute({
    operationId: "flag_changes_export",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/flag-changes/export",
    summary:
      "Export a Flag change-log time range, or the stored changes between two Environments, as JSON plus a unified text diff.",
    request: { params: AppParams, query: FlagChangeExportQuerySchema },
    response: FlagChangeExportResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    effects: readOnlyClosed,
    idempotency: "none",
    errors: [...READ_ERRORS],
  }),
] as const satisfies readonly ApiRouteContract[];
