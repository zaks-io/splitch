import { inverseNormalCdf } from "./normal-distribution";
import { normalMixtureScale, rhoSquaredForTargetN } from "./sequential-ci";

/**
 * Schultzberg closed-form always-valid inflation k* for the engine's
 * normal-mixture aCS at its tuned decision time.
 *
 * At n = target_n the mixture information ratio equals the alpha-only optimum,
 * so the critical scale (and therefore k*) does not depend on the chosen
 * target_n. k* = (u_alpha / z_{alpha/2})^2 where u_alpha is the mixture scale.
 */
export function alwaysValidInflation(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error("alpha must be finite and in (0, 1).");
  }

  // Any positive target_n yields the same scale at the tuned time.
  const referenceTargetN = 1;
  const scale = normalMixtureScale(
    referenceTargetN,
    alpha,
    rhoSquaredForTargetN(alpha, referenceTargetN),
  );
  // Lower-tail form: 1 - alpha/2 rounds to 1 for tiny alpha and inverseNormalCdf throws.
  const zCritical = -inverseNormalCdf(alpha / 2);
  return (scale / zCritical) ** 2;
}

/** Mixture critical scale at the tuned decision time for this alpha. */
export function alwaysValidCriticalScale(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error("alpha must be finite and in (0, 1).");
  }

  const referenceTargetN = 1;
  return normalMixtureScale(referenceTargetN, alpha, rhoSquaredForTargetN(alpha, referenceTargetN));
}
