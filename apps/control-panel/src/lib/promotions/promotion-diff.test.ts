import { describe, expect, it } from "vitest";
import { promotionDiff } from "#lib/promotions/promotion-diff";
import { promotionView, stagingView } from "#lib/promotions/promotion-fixture";

describe("Promotion diff", () => {
  it("emits one row per differing field group at the select granularity", () => {
    const diff = promotionDiff(stagingView(), promotionView());

    expect(diff.rows.map((row) => row.id)).toEqual([
      "availability:beta",
      "targeting",
      "rollout",
      "enabled",
    ]);
    expect(diff.identical).toEqual([]);
  });

  it("collapses the whole Targeting Rule list into ONE atomic row", () => {
    const source = stagingView({
      targetingRules: [
        ...stagingView().targetingRules,
        {
          id: "rule_second",
          priority: 1,
          variantName: "holdout",
          conditions: [{ attribute: "country", operator: "eq", value: '"US"' }],
          segmentConditions: [],
          rolloutPercentage: null,
          segmentId: null,
          segmentName: null,
        },
      ],
    });

    const targeting = promotionDiff(source, promotionView()).rows.filter(
      (row) => row.kind === "targeting",
    );

    // Two rules, still one row. First-match-wins means a promoted subset would
    // produce an order that behaves like neither Environment.
    expect(targeting).toHaveLength(1);
    expect(targeting[0]?.source).toHaveLength(2);
  });

  it("compares rules by behaviour, not by the ids promotion will re-mint", () => {
    const source = stagingView();
    const target = stagingView({
      env: "prod",
      targetingRules: stagingView().targetingRules.map((rule) => ({ ...rule, id: "rule_prod" })),
    });

    const diff = promotionDiff(source, target);

    expect(diff.identical).toContain("targeting");
    expect(diff.rows.some((row) => row.kind === "targeting")).toBe(false);
  });

  it("omits a field group that already matches instead of offering a no-op tick", () => {
    const diff = promotionDiff(stagingView(), stagingView({ env: "prod" }));

    expect(diff.rows).toEqual([]);
    expect(diff.identical).toEqual(["availability", "targeting", "rollout", "enabled"]);
  });

  it("marks an availability row that REMOVES the Variant from the target", () => {
    // The target has beta available and the source does not, so promoting the row
    // takes it away. The marker has to say so; "promote" reads as "add" otherwise.
    const row = promotionDiff(promotionView(), stagingView({ env: "prod" })).rows.find(
      (candidate) => candidate.id === "availability:beta",
    );

    expect(row?.effect).toBe("remove");
  });

  it("reports an un-narrowed source rather than reading its empty list as 'nothing available'", () => {
    const source = promotionView({
      env: "staging",
      availabilityNarrowed: false,
      availableVariantCount: 0,
      catalog: promotionView().catalog.map((variant) => ({
        ...variant,
        availability: "not-narrowed" as const,
      })),
    });

    const diff = promotionDiff(source, promotionView());

    expect(diff.sourceAvailabilityNotNarrowed).toBe(true);
    expect(diff.rows.find((row) => row.kind === "availability")?.source[0]).toContain(
      "whole catalog is a candidate",
    );
  });

  it("names the target's current value and the source's on every row", () => {
    const diff = promotionDiff(stagingView(), promotionView());
    const rollout = diff.rows.find((row) => row.kind === "rollout");

    expect(rollout?.target).toEqual(["No baseline rollout"]);
    expect(rollout?.source).toEqual(["10% of traffic"]);
  });
});
