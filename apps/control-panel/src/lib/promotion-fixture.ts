import type { FlagDetailView } from "./flag-detail-view";

/**
 * Two Environments of one Flag, for the Promotion suites.
 *
 * Source and target are built from the SAME builder with different overrides, so
 * a test that claims a field group differs is claiming it about the one field it
 * overrode rather than about two independently drifting fixtures.
 */
export function promotionView(overrides: Partial<FlagDetailView> = {}): FlagDetailView {
  return {
    flagId: "flag_new_checkout",
    key: "new-checkout",
    name: "New Checkout",
    env: "prod",
    schema: '{"type":"boolean"}',
    configured: true,
    enabled: false,
    catalog: [
      {
        id: "var_control",
        name: "control",
        value: "false",
        isDefault: true,
        availability: "available",
      },
      {
        id: "var_beta",
        name: "beta",
        value: "true",
        isDefault: false,
        availability: "unavailable",
      },
      {
        id: "var_holdout",
        name: "holdout",
        value: "null",
        isDefault: false,
        availability: "unavailable",
      },
    ],
    availableVariantCount: 1,
    availableVariantNames: ["control"],
    availabilityNarrowed: true,
    defaultVariantName: "control",
    targetingRules: [],
    segments: [],
    baselineRolloutPercentage: null,
    controllingExperiment: null,
    ...overrides,
  };
}

/** The staging Environment: beta available, one rule serving it, rollout and kill switch on. */
export function stagingView(overrides: Partial<FlagDetailView> = {}): FlagDetailView {
  return promotionView({
    env: "staging",
    enabled: true,
    availableVariantCount: 2,
    availableVariantNames: ["control", "beta"],
    catalog: promotionView().catalog.map((variant) =>
      variant.name === "beta" ? { ...variant, availability: "available" as const } : variant,
    ),
    targetingRules: [
      {
        id: "rule_staging",
        priority: 0,
        variantName: "beta",
        conditions: [{ attribute: "plan", operator: "eq", value: '"pro"' }],
        segmentConditions: [],
        rolloutPercentage: 25,
        segmentId: null,
        segmentName: null,
      },
    ],
    baselineRolloutPercentage: 10,
    ...overrides,
  });
}
