import { describe, expect, it } from "vitest";
import type { Variant } from "@splitch/contracts";
import { analyzeEnvironmentServing, removalUniformity } from "./flag-removal-serving";

const binaryVariants: Variant[] = [
  { id: "var_off", name: "off", value: false },
  { id: "var_on", name: "on", value: true },
];

const threeVariants: Variant[] = [
  { id: "var_a", name: "a", value: "a" },
  { id: "var_b", name: "b", value: "b" },
  { id: "var_c", name: "c", value: "c" },
];

function baseServingInput(
  overrides: Partial<Parameters<typeof analyzeEnvironmentServing>[0]> = {},
): Parameters<typeof analyzeEnvironmentServing>[0] {
  return {
    appId: "app_1",
    flagKey: "checkout",
    environmentId: "env_dev",
    environmentKey: "dev",
    enabled: true,
    defaultVariantId: "var_off",
    availableVariantNames: [],
    targetingRulesCount: 0,
    rollout: null,
    hasLiveExperiment: false,
    variants: binaryVariants,
    ...overrides,
  };
}

describe("flag-removal-serving baseline paths", () => {
  it("pins the Default Variant when Configuration has no rollout or Targeting", async () => {
    const serving = await analyzeEnvironmentServing(baseServingInput());
    expect(serving).toMatchObject({
      configurationServedVariant: "off",
      servingEvidence: "configuration_unverified",
      blockers: [],
      evaluationError: null,
    });
  });

  it("serves the Environment Default Variant when disabled even with a retained 100% rollout", async () => {
    const serving = await analyzeEnvironmentServing(
      baseServingInput({
        environmentId: "env_prod",
        environmentKey: "prod",
        enabled: false,
        availableVariantNames: ["off", "on"],
        rollout: { percentage: 100, salt: "s" },
      }),
    );
    expect(serving).toMatchObject({
      configurationServedVariant: "off",
      enabled: false,
      blockers: [],
      evaluationError: null,
    });
  });

  it("uses each Environment's own defaultVariantId", async () => {
    const existing = await analyzeEnvironmentServing(
      baseServingInput({ enabled: false, defaultVariantId: "var_off" }),
    );
    const createdAfterDefaultChange = await analyzeEnvironmentServing(
      baseServingInput({
        environmentId: "env_staging",
        environmentKey: "staging",
        enabled: false,
        defaultVariantId: "var_on",
      }),
    );
    expect(existing.configurationServedVariant).toBe("off");
    expect(createdAfterDefaultChange.configurationServedVariant).toBe("on");
    expect(removalUniformity([existing, createdAfterDefaultChange])).toMatchObject({
      removalSafe: false,
      keepVariant: null,
    });
  });

  it("pins treatment at 100% and default at 0% for a two-Variant catalog", async () => {
    const at100 = await analyzeEnvironmentServing(
      baseServingInput({
        environmentId: "env_prod",
        environmentKey: "prod",
        availableVariantNames: ["off", "on"],
        rollout: { percentage: 100, salt: "s" },
      }),
    );
    const at0 = await analyzeEnvironmentServing(
      baseServingInput({
        availableVariantNames: ["off", "on"],
        rollout: { percentage: 0, salt: "s" },
      }),
    );
    expect(at100.configurationServedVariant).toBe("on");
    expect(at0.configurationServedVariant).toBe("off");
  });
});

describe("flag-removal-serving rejection and uniformity", () => {
  it("rejects an ambiguous 3-Variant catalog at both 0% and 100% (evaluation-core)", async () => {
    // evaluation-core requires exactly one non-Default Variant before fractionalEval,
    // so 0% and 100% both reject an ambiguous catalog rather than substituting.
    const at100 = await analyzeEnvironmentServing(
      baseServingInput({
        environmentId: "env_prod",
        environmentKey: "prod",
        defaultVariantId: "var_a",
        availableVariantNames: ["a", "b", "c"],
        rollout: { percentage: 100, salt: "s" },
        variants: threeVariants,
      }),
    );
    const at0 = await analyzeEnvironmentServing(
      baseServingInput({
        defaultVariantId: "var_a",
        availableVariantNames: ["a", "b", "c"],
        rollout: { percentage: 0, salt: "s" },
        variants: threeVariants,
      }),
    );
    expect(at100.configurationServedVariant).toBeNull();
    expect(at100.blockers).toContain("evaluation_rejected");
    expect(at100.evaluationError).toMatch(/exactly one non-Default Variant/);
    expect(at0.configurationServedVariant).toBeNull();
    expect(at0.blockers).toContain("evaluation_rejected");
    expect(at0.evaluationError).toMatch(/exactly one non-Default Variant/);
  });

  it("blocks fractional rollouts, Targeting Rules, and live Experiments without substituting", async () => {
    const fractional = await analyzeEnvironmentServing(
      baseServingInput({
        environmentId: "env_prod",
        environmentKey: "prod",
        availableVariantNames: ["off", "on"],
        rollout: { percentage: 50, salt: "s" },
      }),
    );
    const targeted = await analyzeEnvironmentServing(baseServingInput({ targetingRulesCount: 1 }));
    const experiment = await analyzeEnvironmentServing(
      baseServingInput({
        environmentId: "env_qa",
        environmentKey: "qa",
        hasLiveExperiment: true,
      }),
    );
    expect(fractional.blockers).toContain("fractional_rollout");
    expect(fractional.configurationServedVariant).toBeNull();
    expect(targeted.blockers).toContain("multi_variant_targeting");
    expect(experiment.blockers).toContain("live_experiment");
  });

  it("throws when defaultVariantId names no Variant", async () => {
    await expect(
      analyzeEnvironmentServing(
        baseServingInput({ enabled: false, defaultVariantId: "var_missing" }),
      ),
    ).rejects.toThrow(/defaultVariantId var_missing names no Variant/);
  });

  it("reports uniform keepVariant only when every Environment agrees", async () => {
    const safe = await analyzeEnvironmentServing(baseServingInput({ enabled: false }));
    const other = await analyzeEnvironmentServing(
      baseServingInput({
        environmentId: "env_prod",
        environmentKey: "prod",
        availableVariantNames: ["off", "on"],
        rollout: { percentage: 100, salt: "s" },
      }),
    );
    expect(removalUniformity([safe, safe])).toMatchObject({
      removalSafe: true,
      keepVariant: "off",
      uniformAcrossEnvironments: true,
      removalBlockers: [],
    });
    expect(removalUniformity([safe, other]).removalSafe).toBe(false);
    expect(removalUniformity([safe, other]).keepVariant).toBeNull();
  });
});
