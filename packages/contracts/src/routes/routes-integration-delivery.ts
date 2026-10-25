import { z } from "zod";
import { defineApiRoute } from "../openapi-route";
import { openWorld, updateClosed } from "../route-effects";
import { EnvParams } from "./route-shapes";

const outstanding = z.object({
  pendingCount: z.number().int().nonnegative(),
  leasedCount: z.number().int().nonnegative(),
  oldestOutstandingAgeMs: z.number().nonnegative().nullable(),
});

export const integrationDeliveryRoutes = [
  defineApiRoute({
    operationId: "integration_deliveries_create",
    owner: "control-plane-api",
    method: "POST",
    path: "/apps/:appId/envs/:environmentId/integrations/deliveries",
    summary:
      "Wake this Environment's integration delivery coordinator and read outstanding delivery counts. Cron mode returns the summary without a wake.",
    request: { params: EnvParams },
    response: z.object({
      appId: z.string(),
      environmentId: z.string(),
      wake: z.enum(["scheduled", "cron_noop"]),
      providers: z.object({ convex: outstanding, cloudflare: outstanding }),
    }),
    auth: "control-plane-token",
    permission: "credentials",
    rateLimit: "control-plane-actor",
    idempotency: "none",
    effects: openWorld(updateClosed),
    errors: [
      "ENVIRONMENT_EXPIRED",
      "APP_NOT_FOUND",
      "FORBIDDEN",
      "INSUFFICIENT_SCOPES",
      "SERVICE_UNAVAILABLE",
    ],
  }),
] as const;
