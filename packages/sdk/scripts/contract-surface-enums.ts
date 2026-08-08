/**
 * Hand-maintained enum/type mirrors of the contracts package authoring schemas.
 * Nothing generates this file from Zod — the arrays below are literal retypes
 * of the contracts sources. Structural parity (`contract-surface-parity.test.ts`)
 * and assignability (`contract-surface-assignability.ts`) keep them honest;
 * tsup only bundles them into the public surface.
 */

/** Mirrors contracts `error-code.ts` `errorCodes`. */
export const errorCodes = [
  "VALIDATION_ERROR",
  "ALLOCATION_INVALID",
  "ACTIVATION_TIMESTAMP_INVALID",
  "INVALID_PAGINATION",
  "INVALID_SORT",
  "EXPOSURE_TICKET_INVALID",
  "EXPOSURE_TICKET_EXPIRED",
  "RUN_FROZEN",
  "DECISION_LOCKED",
  "TARGETING_KEY_MISMATCH",
  "RUN_NOT_RUNNING",
  "EXPERIMENT_RUNNING",
  "EXPERIMENT_NO_DRAFT",
  "VARIANT_NOT_AVAILABLE",
  "RESOURCE_NOT_EMPTY",
  "SLUG_CONFLICT",
  "EXPERIMENT_KEY_CONFLICT",
  "EVENT_ID_CONFLICT",
  "EXPERIMENT_NOT_FOUND",
  "RUN_NOT_FOUND",
  "FLAG_NOT_FOUND",
  "VARIANT_NOT_FOUND",
  "METRIC_NOT_FOUND",
  "APP_NOT_FOUND",
  "ORGANIZATION_NOT_FOUND",
  "USER_NOT_FOUND",
  "CREDENTIAL_NOT_FOUND",
  "SEGMENT_NOT_FOUND",
  "PRIVACY_JOB_NOT_FOUND",
  "APPROVAL_REQUEST_NOT_FOUND",
  "UNAUTHORIZED",
  "CREDENTIAL_REVOKED",
  "INSUFFICIENT_SCOPES",
  "FORBIDDEN",
  "ORIGIN_NOT_ALLOWED",
  "APP_MISMATCH",
  "LAST_OWNER_REQUIRED",
  "LAST_ENVIRONMENT_REQUIRED",
  "PRIVACY_CONFIRMATION_REQUIRED",
  "APPROVAL_REVIEW_FORBIDDEN",
  "APPROVAL_REVIEW_REQUIRED",
  "APPROVAL_REQUEST_STALE",
  "APPROVAL_REQUEST_RESOLVED",
  "APPROVAL_APPLICATION_FAILED",
  "IDEMPOTENCY_KEY_CONFLICT",
  "MULTIPLE_VARIANT_CONFLICT",
  "ATTENTION_FANOUT_LIMIT_EXCEEDED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "PRIVACY_JOB_FAILED",
  "INTERNAL_SERVER_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

/** Mirrors contracts `resolution-reason.ts`. */
export const resolutionReasons = [
  "SPLIT",
  "TARGETING_MATCH",
  "DEFAULT",
  "DISABLED",
  "CACHED",
  "STALE",
  "ERROR",
] as const;

export type ResolutionReason = (typeof resolutionReasons)[number];

export const evaluateAllReasons = ["SPLIT", "DEFAULT", "DISABLED", "ERROR"] as const;
export type EvaluateAllReason = (typeof evaluateAllReasons)[number];

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
