import { FlagRemovalBriefResponseSchema } from "../flag-removal";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { ExpiredFlagListResponseSchema } from "../resource-envelopes-flag";
import { readOnlyClosed } from "../route-effects";
import { AppParams, FlagParams } from "./route-shapes";

/**
 * Flag lifecycle read surfaces (expired inventory and removal brief).
 * Kept separate from routes-flags so the catalog mutation file stays under the
 * code-line ratchet.
 */

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

export const flagLifecycleReadRoutes = [
  defineApiRoute({
    operationId: "expired_flags_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/expired-flags",
    summary:
      "List Flags past their expiresAt that still exist and can still be evaluated, most overdue first (bounded; reports its own truncation).",
    request: { params: AppParams },
    response: ExpiredFlagListResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "flag_removal_brief",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/flags/:flagId/removal-brief",
    summary:
      "Advisory brief for removing a Flag from customer code: served Variants per Environment, SDK search shapes, and explicit caveats (read-only; never writes code).",
    request: { params: FlagParams },
    response: FlagRemovalBriefResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["FLAG_NOT_FOUND", "FORBIDDEN", "INTERNAL_SERVER_ERROR"],
  }),
] as const satisfies readonly ApiRouteContract[];
