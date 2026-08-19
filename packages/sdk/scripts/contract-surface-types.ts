// Docblocks ship verbatim in dist/index.d.ts; keep them consumer-facing. See generate-contract-surface.mjs.
import type {
  ErrorCode,
  EvaluateAllReason,
  ResolutionReason,
} from "./generated/contract-surface-members";

export type { ErrorCode, EvaluateAllReason, ResolutionReason };

/** VariantValue = boolean | string | number | JsonObject */
export type VariantValue = boolean | string | number | Record<string, unknown>;

export interface ResolutionDetails {
  value: VariantValue;
  variantName: string | null;
  reason: ResolutionReason;
  ruleId?: string;
  errorCode?: ErrorCode;
  errorMessage?: string;
}

export interface EvaluateAllEntry {
  variant: VariantValue | null;
  variantName: string | null;
  reason: EvaluateAllReason;
  errorCode: ErrorCode | null;
  exposureIdentity: string | null;
  exposureTicket: string | null;
}

export interface DataPlaneEvaluateResponse {
  variant: VariantValue | null;
}

export interface PeekEvaluateResponse {
  variant: VariantValue;
}

export interface EvaluateAllResponse {
  evaluations: Record<string, EvaluateAllEntry>;
}
