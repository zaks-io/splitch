import { describe, expect, it } from "vitest";
import {
  type ConclusionTarget,
  conclusionDraft,
  conclusionRequest,
} from "./experiment-conclusion-model";

const target: ConclusionTarget = {
  environmentId: "env_prod",
  flagId: "flag_checkout",
  version: 7,
  enabled: true,
  availableVariantNames: ["control"],
  targetingRulesJson: "[]",
  rolloutPercentage: null,
  segments: [],
  variants: [
    { id: "variant_control", name: "control" },
    { id: "variant_treatment", name: "treatment" },
  ],
};
const evidence = {
  expectedResultToken: `sha256:${"a".repeat(64)}`,
  dataWatermark: "2026-09-08T00:00:00.000Z",
  idempotencyKey: "conclusion-1",
};

describe("Conclusion authoring", () => {
  it("prefills the target exactly without choosing or making a winner available", () => {
    expect(conclusionDraft(target)).toEqual({
      selectedVariant: "",
      enabled: true,
      availableVariantNames: ["control"],
      targetingRulesJson: "[]",
      hasRollout: false,
      rolloutPercentage: "",
      reason: "",
    });
  });

  it("submits the displayed configuration with the observed version and evidence", () => {
    const draft = {
      ...conclusionDraft(target),
      selectedVariant: "treatment",
      availableVariantNames: ["treatment"],
      hasRollout: true,
      rolloutPercentage: "25",
    };
    const result = conclusionRequest({ draft, target, ...evidence });
    expect(result).toEqual({
      ok: true,
      request: {
        ...evidence,
        selectedVariant: "treatment",
        review: { action: "approve_and_apply" },
        target: {
          environmentId: "env_prod",
          flagId: "flag_checkout",
          expectedConfigVersion: 7,
          proposedConfig: {
            enabled: true,
            availableVariantNames: ["treatment"],
            targetingRules: [],
            rollout: { percentage: 25 },
          },
        },
      },
    });
  });

  it("does not substitute zero for an empty percentage", () => {
    const draft = { ...conclusionDraft(target), selectedVariant: "control", hasRollout: true };
    expect(conclusionRequest({ draft, target, ...evidence })).toEqual({
      ok: false,
      message: "Enter a rollout percentage.",
    });
  });

  it("does not derive availability from the selected Variant", () => {
    const draft = { ...conclusionDraft(target), selectedVariant: "treatment" };
    expect(conclusionRequest({ draft, target, ...evidence })).toMatchObject({ ok: false });
    expect(draft.availableVariantNames).toEqual(["control"]);
  });

  it("rejects malformed or incomplete rules instead of discarding them", () => {
    for (const targetingRulesJson of ["{", "null", '[{"priority":1}]']) {
      const draft = { ...conclusionDraft(target), selectedVariant: "control", targetingRulesJson };
      expect(conclusionRequest({ draft, target, ...evidence })).toMatchObject({ ok: false });
    }
  });
});
