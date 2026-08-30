import { describe, expect, it } from "vitest";
import { ConvexInstallationStatusSchema } from "./convex-integration";

describe("Convex installation status", () => {
  it("accepts a bounded delivery preparation failure", () => {
    expect(
      ConvexInstallationStatusSchema.parse({
        installationId: "00000000-0000-4000-8000-000000000001",
        appId: "app_test",
        environmentId: "env_test",
        environmentVersion: 2,
        status: "active",
        callbackUrl: "https://example.convex.site/integrations/splitch/configuration",
        lastDeliveredVersion: null,
        lastDeliveredAt: null,
        pendingCount: 1,
        oldestPendingAgeMs: 1_000,
        terminalCount: 0,
        latestDeliveryError: {
          kind: "internal",
          code: "DELIVERY_PREPARATION_FAILED",
          occurredAt: "2026-08-30T15:35:52.000Z",
        },
      }).latestDeliveryError,
    ).toEqual({
      kind: "internal",
      code: "DELIVERY_PREPARATION_FAILED",
      occurredAt: "2026-08-30T15:35:52.000Z",
    });
  });
});
