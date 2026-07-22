/** Shared constants for the dark-launch dogfood journey (SPL-168). */

export const DEFAULT_VARIANT = "off";
export const LAUNCH_VARIANT = "on";
export const FLAG_KEY_PREFIX = "dark-launch";
export const COHORT_ATTRIBUTE = "cohort";
export const COHORT_VALUE = "launch";
export const TARGETED_KEY = "dark-launch-user-targeted";
export const UNTARGETED_KEY = "dark-launch-user-untargeted";
/** Documented KV config propagation window (ADR-0009 / five-runtimes.md). */
export const PROPAGATION_WINDOW_MS = 60_000;

export function syntheticKeys(runId) {
  const slug = runId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .slice(0, 24);
  return {
    appKey: `dark-launch-app-${slug}`,
    flagKey: `${FLAG_KEY_PREFIX}-${slug}`,
    appName: `Dark Launch ${slug}`,
    targetedKey: `${TARGETED_KEY}-${slug}`,
    untargetedKey: `${UNTARGETED_KEY}-${slug}`,
    ruleId: `rule-dark-launch-${slug}`,
  };
}

export function variantName(details) {
  if (typeof details.variantName === "string" && details.variantName.length > 0) {
    return details.variantName;
  }
  if (details.value === true) return LAUNCH_VARIANT;
  if (details.value === false) return DEFAULT_VARIANT;
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
