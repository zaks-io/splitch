import type { FlagConfigGetOutput } from "@splitch/control-plane-sdk";
import { describe, expect, it } from "vitest";
import type { FlagDetailData } from "./flag-detail-data";
import { flagDetailView as buildFlagDetailView, isLocked } from "./flag-detail-view";

const NO_SEGMENTS = { items: [], affectedEnvironmentIds: {} };

function flagDetailView(data: FlagDetailData, env: string) {
  return buildFlagDetailView(data, env, NO_SEGMENTS);
}

describe("Flag detail view model", () => {
  it("shows the same Flag differently per Environment from each Environment's config", () => {
    const dev = flagDetailView(detail(devConfig()), "dev");
    const prod = flagDetailView(detail(prodConfig()), "prod");

    expect(dev.enabled).toBe(true);
    expect(prod.enabled).toBe(false);
    expect(dev.catalog.map((variant) => variant.availability)).toEqual(["available", "available"]);
    expect(prod.catalog.map((variant) => variant.availability)).toEqual([
      "available",
      "unavailable",
    ]);
    expect(dev.targetingRules).toHaveLength(1);
    expect(prod.targetingRules).toHaveLength(0);
  });

  it("distinguishes a never-narrowed Configuration from one that excludes a Variant", () => {
    const notNarrowed = flagDetailView(
      detail({ ...devConfig(), availableVariantNames: [] }),
      "dev",
    );

    expect(notNarrowed.availabilityNarrowed).toBe(false);
    expect(notNarrowed.catalog.map((variant) => variant.availability)).toEqual([
      "not-narrowed",
      "not-narrowed",
    ]);
  });

  it("serves nothing when this Environment has no Configuration at all", () => {
    const unconfigured = flagDetailView(detail(null), "prod");

    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.enabled).toBe(false);
    expect(unconfigured.availableVariantCount).toBe(0);
    expect(unconfigured.catalog.every((variant) => variant.availability === "unavailable")).toBe(
      true,
    );
    expect(unconfigured.controllingExperiment).toBeNull();
  });

  it("keeps falsy Variant values legible instead of rendering them as blank", () => {
    const view = flagDetailView(detail(devConfig()), "dev");

    expect(view.catalog.map((variant) => variant.value)).toEqual(["false", "true"]);
  });

  it("orders Targeting Rules by priority and names the Variant each one serves", () => {
    const view = flagDetailView(
      detail({
        ...devConfig(),
        targetingRules: [rule("rule_b", 5, "var_disabled"), rule("rule_a", 1, "var_enabled")],
      }),
      "dev",
    );

    expect(view.targetingRules.map((r) => [r.priority, r.variantName])).toEqual([
      [1, "enabled"],
      [5, "disabled"],
    ]);
  });

  it("shows referenced Segment Conditions beside direct Conditions", () => {
    const data = detail({
      ...devConfig(),
      targetingRules: [{ ...rule("rule_segment", 0, "var_enabled"), segmentId: "segment_paid" }],
    });
    const view = buildFlagDetailView(data, "dev", {
      items: [
        {
          id: "segment_paid",
          appId: "app_checkout",
          name: "Paid plan",
          conditions: [{ attribute: "tier", operator: "eq", value: "paid" }],
          createdAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
      ],
      affectedEnvironmentIds: { segment_paid: ["env_dev"] },
    });

    expect(view.targetingRules[0]).toMatchObject({
      segmentName: "Paid plan",
      segmentConditions: [{ attribute: "tier", operator: "eq", value: '"paid"' }],
      conditions: [{ attribute: "plan", operator: "eq", value: '"pro"' }],
    });
  });

  it("names the offending Segment id when Segment detail data is inconsistent", () => {
    const data = detail({
      ...devConfig(),
      targetingRules: [{ ...rule("rule_segment", 0, "var_enabled"), segmentId: "segment_missing" }],
    });

    expect(() => buildFlagDetailView(data, "dev", NO_SEGMENTS)).toThrow("segment_missing");
  });

  it("reports the controlling Experiment exactly as the Worker did, never inferring one", () => {
    const controlled = flagDetailView(
      detail({ ...devConfig(), experiment: { id: "exp_1", name: "Checkout Copy Dev" } }),
      "dev",
    );

    expect(controlled.controllingExperiment).toEqual({ id: "exp_1", name: "Checkout Copy Dev" });
    expect(flagDetailView(detail(devConfig()), "dev").controllingExperiment).toBeNull();
  });

  it("locks the Experiment-owned field groups and never the kill switch", () => {
    const controlled = flagDetailView(
      detail({ ...devConfig(), experiment: { id: "exp_1", name: "Checkout Copy Dev" } }),
      "dev",
    );

    expect(isLocked(controlled, "availability")).toBe(true);
    expect(isLocked(controlled, "targeting")).toBe(true);
    // The baseline rollout locks too: the Worker refuses it with `RUN_FROZEN`
    // while the Run is live, because the Run's allocation is the sole authority
    // for its traffic and an accepted baseline edit would move nobody.
    expect(isLocked(controlled, "rollout")).toBe(true);
    // Never the kill switch: an incident must always be stoppable.
    expect(isLocked(controlled, "kill-switch")).toBe(false);
  });

  it("locks nothing when no Experiment controls the Flag here", () => {
    const free = flagDetailView(detail(devConfig()), "dev");

    for (const group of ["availability", "targeting", "rollout", "kill-switch"] as const) {
      expect(isLocked(free, group)).toBe(false);
    }
  });

  it("renders the value schema as JSON text and marks an absent schema unconstrained", () => {
    expect(flagDetailView(detail(devConfig()), "dev").schema).toBe('{"type":"boolean"}');

    const data = detail(devConfig());
    expect(
      flagDetailView({ ...data, definition: { ...data.definition, schema: null } }, "dev").schema,
    ).toBeNull();
  });
});

function detail(configuration: FlagConfigGetOutput | null): FlagDetailData {
  return {
    definition: {
      id: "flag_checkout",
      key: "new-checkout",
      name: "New Checkout",
      schema: { type: "boolean" },
      variants: [
        { id: "var_disabled", name: "disabled", value: false },
        { id: "var_enabled", name: "enabled", value: true },
      ],
      defaultVariantId: "var_disabled",
    },
    configuration,
  };
}

function rule(id: string, priority: number, variantId: string) {
  return {
    id,
    flagId: "flag_checkout",
    priority,
    conditions: [{ attribute: "plan", operator: "eq" as const, value: "pro" }],
    variantId,
    percentageRollout: null,
  };
}

function devConfig(): FlagConfigGetOutput {
  return {
    flagId: "flag_checkout",
    environmentId: "env_dev",
    version: 2,
    enabled: true,
    availableVariantNames: ["disabled", "enabled"],
    targetingRules: [rule("rule_dev", 0, "var_enabled")],
    rollout: null,
    experiment: null,
  };
}

function prodConfig(): FlagConfigGetOutput {
  return {
    flagId: "flag_checkout",
    environmentId: "env_prod",
    version: 1,
    enabled: false,
    availableVariantNames: ["disabled"],
    targetingRules: [],
    rollout: null,
    experiment: null,
  };
}
