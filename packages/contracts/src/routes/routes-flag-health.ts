import {
  FlagInventoryHealthResponseSchema,
  StaleFlagListResponseSchema,
} from "../resource-envelopes-flag-health";
import { type ApiRouteContract, defineApiRoute } from "../openapi-route";
import { readOnlyClosed } from "../route-effects";
import { AppParams } from "./route-shapes";

const OWNER = "control-plane-api" as const;
const AUTH = "control-plane-token" as const;
const RATE = "control-plane-actor" as const;

/**
 * Flag inventory health and configuration-state stale detection (plan 3.6 / 3.8).
 * Suggest-only reads: no archive verb, no writes.
 */
export const flagHealthRoutes = [
  defineApiRoute({
    operationId: "stale_flags_list",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/stale-flags",
    summary:
      "List Flags that look stale from configuration state (uniform serving, past expiry, or unchanged), with typed reasons. Serving evidence is always unverified. Suggest only; never archives.",
    request: { params: AppParams },
    response: StaleFlagListResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
  defineApiRoute({
    operationId: "flag_inventory_health_get",
    owner: OWNER,
    method: "GET",
    path: "/apps/:appId/flag-inventory-health",
    summary:
      "Per-App Flag inventory health: counts by lifecycle class, age distribution, monthly additions versus removals, and expired-but-live count.",
    request: { params: AppParams },
    response: FlagInventoryHealthResponseSchema,
    auth: AUTH,
    rateLimit: RATE,
    idempotency: "none",
    effects: readOnlyClosed,
    errors: ["APP_NOT_FOUND", "FORBIDDEN"],
  }),
] as const satisfies readonly ApiRouteContract[];
