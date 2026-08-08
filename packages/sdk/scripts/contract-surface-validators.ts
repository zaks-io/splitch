/**
 * Hand-maintained zod-free mirrors of the contracts package authoring schemas.
 * Nothing generates this file (or `contract-surface-enums.ts` /
 * `contract-surface-descriptors.ts`) from Zod — tsup only bundles them.
 * `contract-surface-parity.test.ts` (structural descriptors + fixtures) and
 * `contract-surface-assignability.ts` (compile-time types) are the guards
 * keeping these mirrors honest.
 *
 * Accepted domain is JSON-only by construction today: every `parse()` call
 * takes `await response.json()`, and these schemas are not exported on a
 * public `./browser` subpath. `isVariantValue` is wider than `z.number()` /
 * `z.record()` (it accepts NaN, Infinity, Date, Map, class instances); that
 * gap is unreachable until a non-JSON caller appears.
 *
 * Response parsers strip unrecognized keys rather than rejecting them: an
 * unknown key means the server is ahead of this mirror, not a malformed
 * payload. Rejecting it would surface as SDK_TRANSPORT_PARSE and collapse
 * every flag to the caller's default.
 */

import {
  type DataPlaneEvaluateResponse,
  type ErrorCode,
  type EvaluateAllEntry,
  type EvaluateAllReason,
  type EvaluateAllResponse,
  errorCodes,
  evaluateAllReasons,
  type PeekEvaluateResponse,
  type ResolutionDetails,
  type ResolutionReason,
  resolutionReasons,
  type VariantValue,
} from "./contract-surface-enums";
import {
  dataPlaneEvaluateKeys,
  evaluateAllEntryKeys,
  evaluateAllResponseKeys,
  peekEvaluateKeys,
  resolutionDetailsKeys,
} from "./contract-surface-keys";

export type {
  DataPlaneEvaluateResponse,
  ErrorCode,
  EvaluateAllEntry,
  EvaluateAllReason,
  EvaluateAllResponse,
  PeekEvaluateResponse,
  ResolutionDetails,
  ResolutionReason,
  VariantValue,
} from "./contract-surface-enums";

interface ParseSuccess<T> {
  success: true;
  data: T;
}

interface ParseFailure {
  success: false;
  error: Error;
}

type ParseResult<T> = ParseSuccess<T> | ParseFailure;

interface Schema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): ParseResult<T>;
}

interface EnumSchema<T extends string> extends Schema<T> {
  readonly options: readonly T[];
}

function fail(message: string): never {
  throw new Error(message);
}

function asSchema<T>(check: (input: unknown) => T): Schema<T> {
  return {
    parse(input: unknown): T {
      return check(input);
    },
    safeParse(input: unknown): ParseResult<T> {
      try {
        return { success: true, data: check(input) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pick known keys; ignore the rest (server-ahead forward compatibility). */
function pickKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(value, key)) {
      out[key] = value[key];
    }
  }
  return out;
}

function requireKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string,
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${path}: missing required key ${JSON.stringify(key)}`);
    }
  }
}

function isVariantValue(value: unknown): value is VariantValue {
  return (
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number" ||
    isPlainObject(value)
  );
}

function parseVariantValue(value: unknown, path: string): VariantValue {
  if (!isVariantValue(value)) {
    fail(`${path} must be boolean | string | number | object`);
  }
  return value;
}

const errorCodeSet: ReadonlySet<string> = new Set(errorCodes);
const resolutionReasonSet: ReadonlySet<string> = new Set(resolutionReasons);
const evaluateAllReasonSet: ReadonlySet<string> = new Set(evaluateAllReasons);

export const ErrorCodeSchema: EnumSchema<ErrorCode> = {
  options: errorCodes,
  ...asSchema((input: unknown): ErrorCode => {
    if (typeof input !== "string" || !errorCodeSet.has(input)) {
      fail("invalid ErrorCode");
    }
    return input as ErrorCode;
  }),
};

function assertResolutionErrorFields(details: ResolutionDetails): void {
  if (details.reason === "ERROR") {
    if (details.errorCode == null) {
      fail("errorCode is required when reason === 'ERROR'");
    }
    return;
  }
  if (details.errorCode != null || details.errorMessage != null) {
    fail("errorCode/errorMessage are present iff reason === 'ERROR'");
  }
}

function assertResolutionRuleId(details: ResolutionDetails): void {
  if (details.reason === "TARGETING_MATCH") {
    if (details.ruleId == null) {
      fail("ruleId is required when reason === 'TARGETING_MATCH'");
    }
    return;
  }
  if (details.ruleId != null) {
    fail("ruleId is present iff reason === 'TARGETING_MATCH'");
  }
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    fail(`${key} must be a string when present`);
  }
  return value;
}

function parseResolutionDetails(input: unknown): ResolutionDetails {
  if (!isPlainObject(input)) {
    fail("ResolutionDetails must be an object");
  }
  const picked = pickKnownKeys(input, resolutionDetailsKeys);
  requireKeys(picked, ["value", "variantName", "reason"], "ResolutionDetails");
  const value = parseVariantValue(picked.value, "value");
  if (!(typeof picked.variantName === "string" || picked.variantName === null)) {
    fail("variantName must be string | null");
  }
  if (typeof picked.reason !== "string" || !resolutionReasonSet.has(picked.reason)) {
    fail("invalid reason");
  }
  const ruleId = readOptionalString(picked, "ruleId");
  const errorMessage = readOptionalString(picked, "errorMessage");
  if (picked.errorCode !== undefined) {
    ErrorCodeSchema.parse(picked.errorCode);
  }

  const details: ResolutionDetails = {
    value,
    variantName: picked.variantName,
    reason: picked.reason as ResolutionReason,
    ...(ruleId !== undefined ? { ruleId } : {}),
    ...(picked.errorCode !== undefined ? { errorCode: picked.errorCode as ErrorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };

  assertResolutionErrorFields(details);
  assertResolutionRuleId(details);
  return details;
}

export const ResolutionDetailsSchema: Schema<ResolutionDetails> = asSchema(parseResolutionDetails);

function parseDataPlaneEvaluateResponse(input: unknown): DataPlaneEvaluateResponse {
  if (!isPlainObject(input)) {
    fail("DataPlaneEvaluateResponse must be an object");
  }
  const picked = pickKnownKeys(input, dataPlaneEvaluateKeys);
  requireKeys(picked, ["variant"], "DataPlaneEvaluateResponse");
  if (picked.variant !== null && !isVariantValue(picked.variant)) {
    fail("variant must be VariantValue | null");
  }
  return { variant: picked.variant as VariantValue | null };
}

export const DataPlaneEvaluateResponseSchema: Schema<DataPlaneEvaluateResponse> = asSchema(
  parseDataPlaneEvaluateResponse,
);

function parsePeekEvaluateResponse(input: unknown): PeekEvaluateResponse {
  if (!isPlainObject(input)) {
    fail("PeekEvaluateResponse must be an object");
  }
  const picked = pickKnownKeys(input, peekEvaluateKeys);
  requireKeys(picked, ["variant"], "PeekEvaluateResponse");
  return { variant: parseVariantValue(picked.variant, "variant") };
}

export const PeekEvaluateResponseSchema: Schema<PeekEvaluateResponse> =
  asSchema(parsePeekEvaluateResponse);

function assertEvaluateAllEntryRefinements(entry: EvaluateAllEntry, path: string): void {
  if (entry.reason === "ERROR" ? entry.errorCode === null : entry.errorCode !== null) {
    fail(`${path}: errorCode is present iff reason === 'ERROR'`);
  }
  if (entry.reason !== "SPLIT" && entry.exposureTicket !== null) {
    fail(`${path}: exposureTicket is only allowed when reason === 'SPLIT'`);
  }
}

function parseEvaluateAllEntry(input: unknown, path: string): EvaluateAllEntry {
  if (!isPlainObject(input)) {
    fail(`${path} must be an object`);
  }
  const picked = pickKnownKeys(input, evaluateAllEntryKeys);
  requireKeys(picked, evaluateAllEntryKeys, path);
  if (picked.variant !== null && !isVariantValue(picked.variant)) {
    fail(`${path}.variant must be VariantValue | null`);
  }
  if (!(typeof picked.variantName === "string" || picked.variantName === null)) {
    fail(`${path}.variantName must be string | null`);
  }
  if (typeof picked.reason !== "string" || !evaluateAllReasonSet.has(picked.reason)) {
    fail(`${path}.reason is invalid`);
  }
  if (picked.errorCode !== null) {
    ErrorCodeSchema.parse(picked.errorCode);
  }
  if (!(typeof picked.exposureTicket === "string" || picked.exposureTicket === null)) {
    fail(`${path}.exposureTicket must be string | null`);
  }

  const entry: EvaluateAllEntry = {
    variant: picked.variant as VariantValue | null,
    variantName: picked.variantName as string | null,
    reason: picked.reason as EvaluateAllReason,
    errorCode: picked.errorCode as ErrorCode | null,
    exposureTicket: picked.exposureTicket as string | null,
  };
  assertEvaluateAllEntryRefinements(entry, path);
  return entry;
}

function parseEvaluateAllResponse(input: unknown): EvaluateAllResponse {
  if (!isPlainObject(input)) {
    fail("EvaluateAllResponse must be an object");
  }
  const picked = pickKnownKeys(input, evaluateAllResponseKeys);
  requireKeys(picked, ["evaluations"], "EvaluateAllResponse");
  if (!isPlainObject(picked.evaluations)) {
    fail("evaluations must be an object");
  }
  // Write with defineProperty so a flag key of "__proto__" becomes an own
  // property instead of hitting Object.prototype.__proto__. The map keeps a
  // normal Object.prototype so Record consumers can call hasOwnProperty /
  // toString. (zod 4.4.3 drops the "__proto__" entry entirely — see the
  // parity suite's divergence pin; Worker-side silent drop is SPL-353.)
  const evaluations: Record<string, EvaluateAllEntry> = {};
  for (const [flagKey, entry] of Object.entries(picked.evaluations)) {
    Object.defineProperty(evaluations, flagKey, {
      value: parseEvaluateAllEntry(entry, `evaluations.${flagKey}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { evaluations };
}

export const EvaluateAllResponseSchema: Schema<EvaluateAllResponse> =
  asSchema(parseEvaluateAllResponse);
