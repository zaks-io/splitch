export interface SequentialSrmWealthState {
  alpha: number[];
  alphaSum: number;
  logWealth: number;
  n: number;
  minInvWealth: number;
  firstCrossN: number | null;
}

export function createSequentialSrmWealthState(
  theta: readonly number[],
  concentration: number,
): SequentialSrmWealthState {
  const alpha = theta.map((probability) => concentration * probability);
  return {
    alpha,
    alphaSum: concentration,
    logWealth: 0,
    n: 0,
    minInvWealth: 1,
    firstCrossN: null,
  };
}

export function applySequentialSrmIncrements(
  state: SequentialSrmWealthState,
  increments: readonly number[],
  theta: readonly number[],
  threshold: number,
): void {
  let added = 0;
  for (let variantIndex = 0; variantIndex < increments.length; variantIndex += 1) {
    added += applyArmIncrements(state, increments[variantIndex] ?? 0, theta, variantIndex);
  }
  if (added > 0) {
    recordLook(state, threshold);
  }
}

/**
 * Materialize numeric wealth from log space.
 *
 * Overflow contract: log evidence may grow beyond what `Math.exp` can represent.
 * When that happens, refuse nonfinite numeric wealth rather than returning
 * `Infinity` (which JSON serializes as `null`). Callers that still need the
 * evidence must keep `logWealth`.
 */
export function wealthFromLog(logWealth: number): number {
  if (!Number.isFinite(logWealth)) {
    throw new Error("Sequential SRM wealth left the finite log domain.");
  }
  const wealth = Math.exp(logWealth);
  if (!Number.isFinite(wealth)) {
    throw new Error(
      `Sequential SRM numeric wealth overflowed (log_wealth=${logWealth}). ` +
        "Evidence remains in log space; refuse nonfinite wealth.",
    );
  }
  return wealth;
}

/** Finite exp(logWealth), or null when the exponential overflows. */
export function tryWealthFromLog(logWealth: number): number | null {
  if (!Number.isFinite(logWealth)) {
    throw new Error("Sequential SRM wealth left the finite log domain.");
  }
  const wealth = Math.exp(logWealth);
  return Number.isFinite(wealth) ? wealth : null;
}

function applyArmIncrements(
  state: SequentialSrmWealthState,
  added: number,
  theta: readonly number[],
  variantIndex: number,
): number {
  const probability = theta[variantIndex];
  if (probability === undefined) {
    throw new Error("Sequential SRM increment length must match allocation.");
  }
  for (let step = 0; step < added; step += 1) {
    applyOneArrival(state, variantIndex, probability);
  }
  return added;
}

function applyOneArrival(
  state: SequentialSrmWealthState,
  variantIndex: number,
  probability: number,
): void {
  const priorAlpha = state.alpha[variantIndex];
  if (priorAlpha === undefined) {
    throw new Error("Sequential SRM increment length must match allocation.");
  }
  // Lindon and Malek eq. (5): bet the Dirichlet posterior mean against theta.
  state.logWealth += Math.log(priorAlpha) - Math.log(state.alphaSum) - Math.log(probability);
  state.alpha[variantIndex] = priorAlpha + 1;
  state.alphaSum += 1;
  state.n += 1;
}

function recordLook(state: SequentialSrmWealthState, threshold: number): void {
  const invWealth = inverseWealth(state.logWealth);
  if (invWealth < state.minInvWealth) {
    state.minInvWealth = invWealth;
  }
  if (state.firstCrossN === null && state.minInvWealth <= threshold) {
    state.firstCrossN = state.n;
  }
}

function inverseWealth(logWealth: number): number {
  if (logWealth <= 0) {
    return 1;
  }
  const inverse = Math.exp(-logWealth);
  return inverse > 1 ? 1 : inverse;
}
