import type { ConvexServerExposureItem } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { mapIndependentExposureItems } from "./convex-exposure-batch";

describe("integration Exposure batch scheduling", () => {
  it("stops a conflicting sequence on failure and starts cleanly on the next batch", async () => {
    const items = [
      item(1, "shared"),
      item(2, "two"),
      item(3, "three"),
      item(4, "four"),
      item(5, "shared"),
    ];
    const started: number[] = [];

    await expect(
      mapIndependentExposureItems(items, async (_item, index) => {
        started.push(index);
        if (index === 0) throw new Error("claim store unavailable");
        return index;
      }),
    ).rejects.toThrow("claim store unavailable");
    expect(started).toEqual([0, 1, 2, 3]);

    await expect(
      mapIndependentExposureItems(items, async (_item, index) => index),
    ).resolves.toEqual([0, 1, 2, 3, 4]);
  });
});

function item(id: number, targetingKey: string): ConvexServerExposureItem {
  return {
    exposureId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    installationId: "00000000-0000-4000-8000-000000000010",
    flagKey: "checkout",
    experimentId: "exp_1",
    runId: "run_1",
    runConfigHash: "sha256:run-1",
    evaluationContext: { targetingKey, idType: "user", attributes: {} },
    variantName: "treatment",
    exposureAt: "2026-08-25T12:00:00.000Z",
  };
}
