/**
 * Zod-free object shapes for the public SDK contract surface. The enum members
 * and response key lists they build on are generated from the contracts
 * package; see `scripts/generate-contract-surface.mjs` for why these
 * declarations are the hand-written remainder and what fails when they drift.
 *
 * Docblocks in this graph land verbatim in the published `dist/index.d.ts`,
 * which must never mention the contracts package by its scoped name: the
 * release pack rejects a declaration file containing it.
 */

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
