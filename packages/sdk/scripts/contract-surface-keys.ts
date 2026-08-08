/**
 * Known response keys for the hand-maintained contract-surface parsers.
 * Kept separate from structural descriptors so the published bundle does not
 * pull the full descriptor graph.
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
