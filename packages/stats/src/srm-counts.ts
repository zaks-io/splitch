export function expectedCountsForOutput(
  total: number,
  allocation: Readonly<Record<string, number>>,
  variants: readonly string[],
): Record<string, number> {
  const allocationTotal = variants.reduce((sum, variant) => sum + (allocation[variant] ?? 0), 0);
  const expected = variants.map((variant) => {
    const exact = (total * (allocation[variant] ?? 0)) / allocationTotal;
    return { variant, floor: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remaining = total - expected.reduce((sum, value) => sum + value.floor, 0);
  const sortedByRemainder = [...expected].sort((left, right) => right.fraction - left.fraction);

  for (const value of sortedByRemainder) {
    if (remaining <= 0) {
      break;
    }
    value.floor += 1;
    remaining -= 1;
  }

  return Object.fromEntries(expected.map(({ variant, floor }) => [variant, floor]));
}

export function zeroCounts(variants: readonly string[]): Record<string, number> {
  return Object.fromEntries(variants.map((variant) => [variant, 0]));
}

export function sumCounts(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

export function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
