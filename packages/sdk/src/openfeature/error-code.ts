import type { OfrepErrorCode } from "./types";

const OPEN_FEATURE_ERROR_CODES: ReadonlySet<string> = new Set([
  "PROVIDER_NOT_READY",
  "PROVIDER_FATAL",
  "FLAG_NOT_FOUND",
  "PARSE_ERROR",
  "TYPE_MISMATCH",
  "TARGETING_KEY_MISSING",
  "INVALID_CONTEXT",
  "GENERAL",
]);

/** Narrow a wire/string code to OpenFeature's `ErrorCode` enum type. */
export function toOfrepErrorCode(
  value: unknown,
  fallback: OfrepErrorCode = "GENERAL" as OfrepErrorCode,
): OfrepErrorCode {
  return typeof value === "string" && OPEN_FEATURE_ERROR_CODES.has(value)
    ? (value as OfrepErrorCode)
    : fallback;
}
