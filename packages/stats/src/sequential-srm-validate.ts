export interface ParsedAllocation {
  readonly variants: readonly string[];
  readonly theta: readonly number[];
}

export function parseSequentialSrmAlpha(alpha: number | undefined, fallback: number): number {
  const value = alpha ?? fallback;
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error("Sequential SRM alpha must be finite and in (0, 1).");
  }
  return value;
}

export function parseSequentialSrmConcentration(
  concentration: number | undefined,
  fallback: number,
): number {
  const value = concentration ?? fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Sequential SRM concentration must be a finite positive number.");
  }
  return value;
}

export function parseSequentialSrmAllocation(
  allocation: Readonly<Record<string, number>>,
): ParsedAllocation {
  const variants = Object.keys(allocation);
  if (variants.length < 2) {
    throw new Error("Sequential SRM allocation requires at least two variants.");
  }

  const weights = variants.map((variant) => {
    const weight = allocation[variant];
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Sequential SRM allocation for ${variant} must be positive.`);
    }
    return weight;
  });

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Sequential SRM allocation total must be positive.");
  }

  return {
    variants,
    theta: weights.map((weight) => weight / total),
  };
}

export function countVectorFromRecord(
  counts: Readonly<Record<string, number>>,
  variants: readonly string[],
  label: string,
): number[] {
  const declared = new Set(variants);
  for (const variant of Object.keys(counts)) {
    if (!declared.has(variant)) {
      throw new Error(`Sequential SRM ${label} includes undeclared variant ${variant}.`);
    }
  }

  return variants.map((variant) => {
    const value = counts[variant] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Sequential SRM ${label} for ${variant} must be a nonnegative safe integer.`);
    }
    return value;
  });
}

export function subtractCountVectors(
  current: readonly number[],
  previous: readonly number[],
  variants: readonly string[],
): number[] {
  return current.map((value, index) => {
    const prior = previous[index] ?? 0;
    if (value < prior) {
      const variant = variants[index] ?? "unknown";
      throw new Error(
        `Sequential SRM cumulative counts for ${variant} decreased from ${prior} to ${value}. ` +
          "Append-only observations are required; revising earlier counts " +
          "(including __multiple__ quarantine) violates the contract.",
      );
    }
    return value - prior;
  });
}
