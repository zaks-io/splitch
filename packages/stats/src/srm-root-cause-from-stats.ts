import type { StatsOutput } from "@splitch/contracts";
import { classifySrmRootCause } from "./srm-root-cause";
import type { SrmRootCauseClassification, SrmRootCauseInput } from "./srm-root-cause-types";

/**
 * Map a ready `StatsOutput` onto the Fabijan classifier. Results alone never
 * invents day or Dimension SRM.
 */
export function srmRootCauseInputFromStats(stats: StatsOutput): SrmRootCauseInput {
  return {
    exposureMismatch: stats.srm.srm_is_mismatch,
    activatedMismatch: stats.srm.activated_srm_mismatch,
    activationCount: activationCountFromStats(stats),
  };
}

export function classifySrmRootCauseFromStats(
  stats: StatsOutput,
): SrmRootCauseClassification | null {
  return classifySrmRootCause(srmRootCauseInputFromStats(stats));
}

/**
 * Reconstruct activated-population size from health rates × deduped Exposure
 * denominators. `null` when there is no Activation gate; `0` when the gate
 * exists and every arm’s Activation rate is zero (fail-closed sentinel).
 * Rate keys and Exposure denominator keys must match — a missing denominator
 * must not silently become zero and fabricate a zero-Activation explanation.
 */
function activationCountFromStats(stats: StatsOutput): number | null {
  if (stats.srm.activated_srm_mismatch === null) {
    return null;
  }
  const rates = stats.health.activation_rates;
  if (rates === null) {
    return null;
  }
  assertRateKeysMatchDenominators(rates, stats.health.deduped_counts);
  let total = 0;
  for (const [variant, rate] of Object.entries(rates)) {
    total += activatedFromRate(variant, rate, stats.health.deduped_counts);
  }
  return total;
}

function assertRateKeysMatchDenominators(
  rates: Readonly<Record<string, number>>,
  denominators: Readonly<Record<string, number>>,
): void {
  const rateKeys = Object.keys(rates).sort();
  const countKeys = Object.keys(denominators).sort();
  if (
    rateKeys.length !== countKeys.length ||
    rateKeys.some((key, index) => key !== countKeys[index])
  ) {
    throw new Error(
      `activation_rates keys must match deduped_counts keys; rates=${JSON.stringify(rateKeys)} counts=${JSON.stringify(countKeys)}.`,
    );
  }
}

function activatedFromRate(
  variant: string,
  rate: number,
  denominators: Readonly<Record<string, number>>,
): number {
  if (!(variant in denominators)) {
    throw new Error(
      `activation_rates.${variant} has no matching Exposure denominator in deduped_counts.`,
    );
  }
  const exposed = denominators[variant];
  if (typeof exposed !== "number" || !Number.isInteger(exposed) || exposed < 0) {
    throw new Error(
      `deduped_counts.${variant} must be a non-negative integer; received ${JSON.stringify(exposed)}.`,
    );
  }
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
    throw new Error(
      `activation_rates.${variant} must be a finite non-negative number; received ${JSON.stringify(rate)}.`,
    );
  }
  return Math.round(rate * exposed);
}
