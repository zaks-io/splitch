export type VariantValue = boolean | string | number | Record<string, unknown>;

export interface EvaluationContext {
  targetingKey: string;
  idType: string;
  attributes: Record<string, unknown>;
}

export interface ResolutionDetails {
  value: VariantValue;
  variantName: string | null;
  reason: "SPLIT" | "TARGETING_MATCH" | "DEFAULT" | "DISABLED" | "CACHED" | "STALE" | "ERROR";
  ruleId?: string;
  errorCode?: string;
  errorMessage?: string;
}
