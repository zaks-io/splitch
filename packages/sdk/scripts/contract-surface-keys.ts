/**
 * Known response keys for the hand-maintained contract-surface mirrors.
 *
 * `evaluateAllEntryKeys` is parser-facing: `contract-surface-validators.ts`
 * imports it for `requireKeys` on evaluate-all entries, and that is the only
 * key array that lands in the published bundle. Kept in this file (not inlined
 * next to the descriptors) so the tsup entry graph does not pull the full
 * descriptor graph into dist.
 *
 * `dataPlaneEvaluateKeys`, `peekEvaluateKeys`, `resolutionDetailsKeys`, and
 * `evaluateAllResponseKeys` are descriptor-only: imported solely by
 * `contract-surface-descriptors.ts` for structural parity, never by the
 * validators / tsup entry.
 */

export const evaluateAllEntryKeys = [
  "variant",
  "variantName",
  "reason",
  "errorCode",
  "exposureTicket",
] as const;

export const dataPlaneEvaluateKeys = ["variant"] as const;
export const peekEvaluateKeys = ["variant"] as const;
export const resolutionDetailsKeys = [
  "value",
  "variantName",
  "reason",
  "ruleId",
  "errorCode",
  "errorMessage",
] as const;
export const evaluateAllResponseKeys = ["evaluations"] as const;
