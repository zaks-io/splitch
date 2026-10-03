/**
 * Search shapes for Flag references in customer code, derived from the real
 * public API names in packages/sdk (thin client, React hooks, OpenFeature
 * provider). Do not invent accessors that the SDK does not export.
 */

export function flagRemovalSdkCallShapes(flagKey: string): string[] {
  if (flagKey.length === 0) {
    throw new Error("flagRemovalSdkCallShapes: flagKey must be non-empty");
  }
  const q = JSON.stringify(flagKey);
  return [
    // packages/sdk thin client (SplitchClient)
    `evaluate(${q}`,
    `evaluateDetails(${q}`,
    `peekVariant(${q}`,
    `verify(${q}`,
    // packages/sdk/react
    `useFlag(${q}`,
    `useFlagDetails(${q}`,
    // packages/sdk/openfeature provider methods
    `resolveBooleanEvaluation(${q}`,
    `resolveStringEvaluation(${q}`,
    `resolveNumberEvaluation(${q}`,
    `resolveObjectEvaluation(${q}`,
  ];
}
