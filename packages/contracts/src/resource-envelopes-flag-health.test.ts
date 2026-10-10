import { flagResourceFixture } from "@splitch/contracts/testing";
import { describe, expect, it } from "vitest";
import {
  FlagInventoryHealthResponseSchema,
  StaleFlagListResponseSchema,
} from "./resource-envelopes-flag-health";
import { getRoute } from "./route-registry";

const flagLeaf = flagResourceFixture({
  id: "flag_1",
  appId: "app_1",
  key: "checkout",
  name: "Checkout",
  schema: { type: "boolean" },
  variants: [
    { id: "var_1", name: "control", value: false },
    { id: "var_2", name: "treatment", value: true },
  ],
  lifecycleClass: "release",
  owner: "checkout-team",
  expiresAt: "2026-06-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("Flag health envelopes", () => {
  it("parses a stale list item with unverified serving evidence", () => {
    const parsed = StaleFlagListResponseSchema.parse({
      items: [
        {
          flag: flagLeaf,
          reasons: [
            {
              kind: "past_expiry",
              expiresAt: "2026-06-01T00:00:00.000Z",
              lifecycleClass: "release",
            },
          ],
          servingEvidence: "unverified",
          uniformServing: { state: "available" },
        },
      ],
      readTruncated: false,
      readLimit: 200,
      cursor: null,
    });
    expect(parsed.items[0]?.servingEvidence).toBe("unverified");
    expect(parsed.items[0]?.uniformServing).toEqual({ state: "available" });
  });

  it("parses unknown uniform-serving history without a definite uniform reason", () => {
    const parsed = StaleFlagListResponseSchema.parse({
      items: [
        {
          flag: flagLeaf,
          reasons: [],
          servingEvidence: "unverified",
          uniformServing: { state: "unknown", reason: "run_history_unavailable" },
        },
      ],
      readTruncated: false,
      readLimit: 200,
      cursor: null,
    });
    expect(parsed.items[0]?.uniformServing).toEqual({
      state: "unknown",
      reason: "run_history_unavailable",
    });
  });

  it("parses inventory health with named churn sources", () => {
    const parsed = FlagInventoryHealthResponseSchema.parse({
      appId: "app_1",
      asOf: "2026-07-02T12:00:00.000Z",
      countsByLifecycleClass: {
        release: 1,
        experiment: 0,
        ops: 0,
        permission: 0,
        unclassified: 0,
      },
      ageDistribution: [
        { bucket: "0_30d", count: 1 },
        { bucket: "30_90d", count: 0 },
        { bucket: "90_180d", count: 0 },
        { bucket: "180_365d", count: 0 },
        { bucket: "365d_plus", count: 0 },
      ],
      monthlyChurn: {
        months: [{ month: "2026-07", added: 1, removed: 0, coverage: "complete" }],
        additionsSource: "flag_change_log",
        removalsSource: "flag_change_log",
        historyCoverageStartsAt: "2026-07-01T00:00:00.000Z",
      },
      expiredButLiveCount: 1,
    });
    expect(parsed.monthlyChurn.additionsSource).toBe("flag_change_log");
    expect(parsed.monthlyChurn.historyCoverageStartsAt).toBe("2026-07-01T00:00:00.000Z");
    expect(parsed.monthlyChurn.months[0]?.coverage).toBe("complete");
  });

  it("registers both health routes as readOnlyClosed", () => {
    expect(getRoute("stale_flags_list")).toMatchObject({
      method: "GET",
      path: "/apps/:appId/stale-flags",
      effects: { mutates: false, destructive: false },
    });
    expect(getRoute("flag_inventory_health_get")).toMatchObject({
      method: "GET",
      path: "/apps/:appId/flag-inventory-health",
      effects: { mutates: false, destructive: false },
    });
  });
});
