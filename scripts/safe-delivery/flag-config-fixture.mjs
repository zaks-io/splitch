import { DEFAULT_VARIANT } from "./constants.mjs";

/** A minimal FlagConfigResponse shape for assertion tests. */
export function flagConfig(base) {
  return {
    flagId: "flag-1",
    environmentId: "env-prod",
    version: 1,
    enabled: false,
    availableVariantNames: [DEFAULT_VARIANT],
    targetingRules: [],
    rollout: null,
    experiment: null,
    ...base,
  };
}
