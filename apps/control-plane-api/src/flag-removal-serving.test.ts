import { describe, expect, it } from "vitest";
import type { HydratedFlagConfiguration, Variant } from "@splitch/contracts";
import { analyzeEnvironmentServing, removalUniformity } from "./flag-removal-serving";

const variants: Variant[] = [
  { id: "var_off", name: "off", value: false },
  { id: "var_on", name: "on", value: true },
];

function config(overrides: Partial<HydratedFlagConfiguration> = {}): HydratedFlagConfiguration {
  return {
    environmentId: "env_dev",
    enabled: true,
    availableVariantNames: [],
    targetingRules: [],
    rollout: null,
    experiment: null,
    ...overrides,
  };
}

describe("flag-removal-serving", () => {
  it("pins the Default Variant when Configuration has no rollout or Targeting", () => {
    const serving = analyzeEnvironmentServing({
      environmentId: "env_dev",
      environmentKey: "dev",
      configuration: config(),
      defaultVariantName: "off",
      variants,
    });
    expect(serving).toMatchObject({
      configurationServedVariant: "off",
      servingEvidence: "configuration_unverified",
      blockers: [],
    });
  });

  it("blocks a fractional baseline rollout", () => {
    const serving = analyzeEnvironmentServing({
      environmentId: "env_prod",
      environmentKey: "prod",
      configuration: config({
        environmentId: "env_prod",
        rollout: { percentage: 50, salt: "s" },
        availableVariantNames: ["off", "on"],
      }),
      defaultVariantName: "off",
      variants,
    });
    expect(serving.configurationServedVariant).toBeNull();
    expect(serving.blockers).toContain("fractional_rollout");
  });

  it("pins the treatment when baseline rollout is 100%", () => {
    const serving = analyzeEnvironmentServing({
      environmentId: "env_prod",
      environmentKey: "prod",
      configuration: config({
        environmentId: "env_prod",
        rollout: { percentage: 100, salt: "s" },
        availableVariantNames: ["off", "on"],
      }),
      defaultVariantName: "off",
      variants,
    });
    expect(serving).toMatchObject({
      configurationServedVariant: "on",
      blockers: [],
    });
  });

  it("blocks a live Experiment", () => {
    const serving = analyzeEnvironmentServing({
      environmentId: "env_dev",
      environmentKey: "dev",
      configuration: config({ experiment: { id: "exp_1", key: "checkout" } }),
      defaultVariantName: "off",
      variants,
    });
    expect(serving.configurationServedVariant).toBeNull();
    expect(serving.blockers).toContain("live_experiment");
  });

  it("reports uniform keepVariant only when every Environment agrees", () => {
    const safe = analyzeEnvironmentServing({
      environmentId: "env_dev",
      environmentKey: "dev",
      configuration: config(),
      defaultVariantName: "off",
      variants,
    });
    const other = analyzeEnvironmentServing({
      environmentId: "env_prod",
      environmentKey: "prod",
      configuration: config({
        environmentId: "env_prod",
        rollout: { percentage: 100, salt: "s" },
        availableVariantNames: ["off", "on"],
      }),
      defaultVariantName: "off",
      variants,
    });
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
