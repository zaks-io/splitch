import { describe, expect, it, vi } from "vitest";
import { getFlagInventoryHealth } from "./flag-inventory-health-handler";

/**
 * Regression: inventory aggregates must share one asOf with the response body
 * so age buckets and expired-but-live count evaluate the same instant.
 */
describe("getFlagInventoryHealth asOf snapshot", () => {
  it("binds the response asOf into the inventory aggregate read", async () => {
    const asOf = "2026-07-02T12:00:01.000Z";
    const loadInventoryHealthAggregates = vi.fn(async () => ({
      classRows: [{ lifecycleClass: "release", count: 1 }],
      ageBuckets: [
        { bucket: "0_30d", count: 1 },
        { bucket: "30_90d", count: 0 },
        { bucket: "90_180d", count: 0 },
        { bucket: "180_365d", count: 0 },
        { bucket: "365d_plus", count: 0 },
      ],
      creationMonths: [{ month: "2026-07", count: 1 }],
      deletionMonths: [],
      earliestLog: "2026-07-02T12:00:00.500Z",
      expiredButLiveCount: 0,
    }));

    const deps = {
      nowIso: () => asOf,
      repo: {
        identity: {
          getApp: vi.fn(async () => ({ id: "app_race" })),
        },
        flagHealth: {
          loadInventoryHealthAggregates,
        },
      },
    };

    const res = await getFlagInventoryHealth(
      deps as never,
      {
        input: { params: { appId: "app_race" } },
        requestId: "req_race",
        principal: { kind: "user", userId: "user_1", orgId: "org_1" },
      } as never,
    );

    expect(res.status).toBe(200);
    expect(loadInventoryHealthAggregates).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app_race" }),
      asOf,
    );
    const body = (await res.json()) as {
      asOf: string;
      ageDistribution: Array<{ bucket: string; count: number }>;
    };
    expect(body.asOf).toBe(asOf);
    expect(body.ageDistribution.find((row) => row.bucket === "0_30d")?.count).toBe(1);
  });
});
