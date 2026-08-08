import type { EvaluateAllEntry } from "@splitch/contracts";

/**
 * Write a Flag Key into the Precomputed Evaluations map as an own property.
 * A plain `map[flagKey] = entry` assignment drops `"__proto__"` via the
 * prototype setter; the response schema must see the key so it can fail loud
 * (ADR-0036 / SPL-353) instead of silently omitting the Flag.
 */
export function setOwnEvaluation(
  evaluations: Record<string, EvaluateAllEntry>,
  flagKey: string,
  entry: EvaluateAllEntry,
): void {
  Object.defineProperty(evaluations, flagKey, {
    value: entry,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
