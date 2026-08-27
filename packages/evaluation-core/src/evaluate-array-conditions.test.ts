import type { ResolvedTargetingRule, Variant } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { evaluatePath } from "./evaluate";
import type { AssignmentStoreReader, FlagConfig, Provider } from "./types";

const variants: Variant[] = [
  { id: "v-control", name: "control", value: false },
  { id: "v-treatment", name: "treatment", value: true },
];

const rolesRule: ResolvedTargetingRule = {
  id: "rule-roles-admin",
  flagId: "flag-1",
  priority: 0,
  conditions: [{ attribute: "roles", operator: "in", value: ["admin"] }],
  variantId: "v-treatment",
};

function flagOnly(targetingRules: ResolvedTargetingRule[]): FlagConfig {
  return {
    flagKey: "checkout-banner",
    appId: "app-A",
    environmentId: "env-1",
    experimentId: null,
    enabled: true,
    defaultVariant: "control",
    variants,
    availableVariantNames: variants.map((variant) => variant.name),
    targetingRules,
    rollout: null,
  };
}

const unusedStore: AssignmentStoreReader = {
  async getAll() {
    return new Map();
  },
  async put() {
    throw new Error("flag-only evaluatePath must not write holdovers");
  },
  async putHashed() {
    throw new Error("flag-only evaluatePath must not write holdovers");
  },
};

function provider(flag: FlagConfig): Provider {
  return {
    async getFlag() {
      return flag;
    },
    async getExperiment() {
      throw new Error("flag-only evaluatePath must not resolve an Experiment");
    },
    async getFlags() {
      return [flag];
    },
  };
}

describe("evaluatePath array-valued Condition attributes", () => {
  it("matches in when any roles element is in the expected list", async () => {
    const result = await evaluatePath(
      {
        appId: "app-A",
        environmentId: "env-1",
        flagKey: "checkout-banner",
        evaluationContext: {
          targetingKey: "user-1",
          idType: "user",
          attributes: { roles: ["admin", "analyst"] },
        },
      },
      { assignmentStore: unusedStore, provider: provider(flagOnly([rolesRule])) },
    );

    expect(result).toMatchObject({
      kind: "rule_match_direct",
      variant: "treatment",
      reason: { type: "rule_matched", ruleId: "rule-roles-admin" },
      liveRunId: null,
      exposure: null,
    });
  });

  it("does not match in when no roles element is in the expected list", async () => {
    const result = await evaluatePath(
      {
        appId: "app-A",
        environmentId: "env-1",
        flagKey: "checkout-banner",
        evaluationContext: {
          targetingKey: "user-1",
          idType: "user",
          attributes: { roles: ["viewer"] },
        },
      },
      { assignmentStore: unusedStore, provider: provider(flagOnly([rolesRule])) },
    );

    expect(result).toMatchObject({
      kind: "no_match_default",
      variant: "control",
      reason: { type: "no_match_default" },
      liveRunId: null,
      exposure: null,
    });
  });
});
