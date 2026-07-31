/** Shared constants for the safe Flag delivery tracer (SPL-151). */

export const DEFAULT_VARIANT = "control";
export const LAUNCH_VARIANT = "beta";
/** Present in the App-level catalog but deliberately never made available in prod. */
export const DANGLING_VARIANT = "holdout";

export const COHORT_ATTRIBUTE = "plan";
export const COHORT_VALUE = "pro";
export const UNTARGETED_COHORT_VALUE = "free";

/** Baseline Percentage Rollout tuned in dev; never selected for Promotion. */
export const DEV_ROLLOUT_PERCENTAGE = 25;

/** Documented KV config propagation window (ADR-0009 / five-runtimes.md). */
export const PROPAGATION_WINDOW_MS = 60_000;
export const POLL_INTERVAL_MS = 250;

/**
 * The four Promotion field groups (`PromoteRequestSchema.select`). A Promotion
 * applies only the groups named here that the caller explicitly selected.
 */
export const FIELD_GROUPS = Object.freeze(["availability", "targeting", "rollout", "enabled"]);

export function syntheticKeys(runId) {
  const slug = runId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .slice(0, 24);
  return {
    slug,
    primaryFlagKey: `safe-delivery-${slug}`,
    danglingFlagKey: `safe-delivery-dangling-${slug}`,
    staleFlagKey: `safe-delivery-stale-${slug}`,
    targetedKey: `safe-delivery-user-targeted-${slug}`,
    untargetedKey: `safe-delivery-user-untargeted-${slug}`,
    primaryRuleId: `rule-safe-delivery-${slug}`,
    danglingRuleId: `rule-safe-delivery-dangling-${slug}`,
    staleRuleId: `rule-safe-delivery-stale-${slug}`,
    segmentName: `safe-delivery-cohort-${slug}`,
  };
}

/** Every transient Flag this tracer can leave behind, for the orphan sweep. */
export function transientFlagKeys(keys) {
  return [keys.primaryFlagKey, keys.danglingFlagKey, keys.staleFlagKey];
}

export function variantName(details) {
  if (typeof details.variantName === "string" && details.variantName.length > 0) {
    return details.variantName;
  }
  if (typeof details.variant === "string" && details.variant.length > 0) return details.variant;
  throw new Error(`unable to map resolution to a Variant name: ${JSON.stringify(details)}`);
}

export function assertVariant(details, expected, label) {
  const actual = variantName(details);
  if (actual !== expected) {
    throw new Error(
      `${label}: expected Variant "${expected}", got "${actual}" (${JSON.stringify(details)})`,
    );
  }
  if (details.reason === "ERROR") {
    throw new Error(`${label}: resolution failed loud with ERROR`);
  }
}
