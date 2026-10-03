import { rhoSquaredForTargetN } from "./sequential-ci";

/**
 * One-sided normal-mixture scale from Waudby-Smith et al. Proposition B.1.
 * Differs from the two-sided bound at doubled alpha by the additive 1 inside
 * the log: log(1 + sqrt(t ρ² + 1) / (2 α)), not log(sqrt(t ρ² + 1) / (2 α)).
 *
 * Rho is tuned at 2α (paper §B.2 footnote): the two-sided optimizer with the
 * one-sided alpha doubled, so the information target matches the one-sided
 * mixture rather than silently reusing the two-sided ρ(α).
 */
export function normalMixtureOneSidedScale(n: number, alpha: number, rhoSquared: number): number {
  if (!(n > 0) || !Number.isFinite(n)) {
    throw new Error("n must be finite and positive for the one-sided mixture scale.");
  }
  if (!(alpha > 0) || !(alpha < 1) || !Number.isFinite(alpha)) {
    throw new Error("alpha must be finite and in (0, 1) for the one-sided mixture scale.");
  }
  if (!(rhoSquared > 0) || !Number.isFinite(rhoSquared)) {
    throw new Error("rhoSquared must be finite and positive for the one-sided mixture scale.");
  }

  const informationRatio = n * rhoSquared;
  const logTerm = Math.log(1 + Math.sqrt(1 + informationRatio) / (2 * alpha));
  return Math.sqrt((2 * (1 + informationRatio) * logTerm) / informationRatio);
}

/** Rho for Proposition B.1: two-sided optimizer at 2α, per Waudby-Smith §B.2. */
export function rhoSquaredForOneSidedTargetN(alpha: number, targetN: number): number {
  if (!(alpha > 0) || !(alpha < 0.5) || !Number.isFinite(alpha)) {
    throw new Error(
      "one-sided alpha must be finite and in (0, 0.5) so the 2α rho tune stays in (0, 1).",
    );
  }
  return rhoSquaredForTargetN(2 * alpha, targetN);
}

export function normalMixtureOneSidedBoundary(
  standardError: number,
  n: number,
  alpha: number,
  targetN: number,
): number {
  if (!(standardError >= 0) || !Number.isFinite(standardError)) {
    throw new Error("standardError must be finite and non-negative.");
  }
  if (!(targetN > 0) || !Number.isFinite(targetN)) {
    throw new Error("target_n must be finite and positive for the one-sided boundary.");
  }
  const rhoSquared = rhoSquaredForOneSidedTargetN(alpha, targetN);
  return standardError * normalMixtureOneSidedScale(n, alpha, rhoSquared);
}
