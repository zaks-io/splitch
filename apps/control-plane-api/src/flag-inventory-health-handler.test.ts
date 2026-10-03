import { describe, expect, it, vi } from "vitest";
import { getFlagInventoryHealth } from "./flag-inventory-health-handler";

/**
 * Regression: capturing asOf before awaiting inventory reads lets a concurrent
 * create land with createdAt > asOf, and flagAgeBucket throws on negative age.
 */
describe("getFlagInventoryHealth asOf snapshot", () => {
  it("ages a Flag created between an early clock read and the inventory query", async () => {
    const earlyAsOf = "2026-07-02T12:00:00.000Z";
    const createdDuringRead = "2026-07-02T12:00:00.500Z";
    const afterReadsAsOf = "2026-07-02T12:00:01.000Z";
    let readsStarted = false;

    const deps = {
      nowIso: () => (readsStarted ? afterReadsAsOf : earlyAsOf),
      repo: {
        identity: {
          getApp: vi.fn(async () => ({ id: "app_race" })),
        },
        flagHealth: {
          countFlagsByLifecycleClass: vi.fn(async () => {
            readsStarted = true;
            return [{ lifecycleClass: "release", count: 1 }];
          }),
          listFlagCreatedAt: vi.fn(async () => {
            readsStarted = true;
            return [{ createdAt: createdDuringRead }];
          }),
          countFlagCreationsByMonth: vi.fn(async () => {
            readsStarted = true;
            return [{ month: "2026-07", count: 1 }];
          }),
          countFlagDeletionsByMonth: vi.fn(async () => {
            readsStarted = true;
            return [];
          }),
          earliestChangeLogAt: vi.fn(async () => {
            readsStarted = true;
            return createdDuringRead;
          }),
          countExpiredFlags: vi.fn(async () => 0),
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
    const body = (await res.json()) as {
      asOf: string;
      ageDistribution: Array<{ bucket: string; count: number }>;
    };
    expect(body.asOf).toBe(afterReadsAsOf);
    expect(body.ageDistribution.find((row) => row.bucket === "0_30d")?.count).toBe(1);
  });
});
