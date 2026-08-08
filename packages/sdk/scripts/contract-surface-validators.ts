/**
 * Zod-free validators compiled into the public SDK contract surface.
 * Keep `contract-surface-parity.test.ts` green when either side changes.
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

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`unexpected key ${JSON.stringify(key)}`);
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
  const value = parseVariantValue(input.value, "value");
  if (!(typeof input.variantName === "string" || input.variantName === null)) {
    fail("variantName must be string | null");
  }
  if (typeof input.reason !== "string" || !resolutionReasonSet.has(input.reason)) {
    fail("invalid reason");
  }
  const ruleId = readOptionalString(input, "ruleId");
  const errorMessage = readOptionalString(input, "errorMessage");
  if (input.errorCode !== undefined) {
    ErrorCodeSchema.parse(input.errorCode);
  }

  const details: ResolutionDetails = {
    value,
    variantName: input.variantName,
    reason: input.reason as ResolutionReason,
    ...(ruleId !== undefined ? { ruleId } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode as ErrorCode } : {}),
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
  assertExactKeys(input, ["variant"]);
  if (!("variant" in input)) {
    fail("variant is required");
  }
  if (input.variant !== null && !isVariantValue(input.variant)) {
    fail("variant must be VariantValue | null");
  }
  return { variant: input.variant };
}

export const DataPlaneEvaluateResponseSchema: Schema<DataPlaneEvaluateResponse> = asSchema(
  parseDataPlaneEvaluateResponse,
);

function parsePeekEvaluateResponse(input: unknown): PeekEvaluateResponse {
  if (!isPlainObject(input)) {
    fail("PeekEvaluateResponse must be an object");
  }
  assertExactKeys(input, ["variant"]);
  if (!("variant" in input)) {
    fail("variant is required");
  }
  return { variant: parseVariantValue(input.variant, "variant") };
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
  assertExactKeys(input, ["variant", "variantName", "reason", "errorCode", "exposureTicket"]);
  if (input.variant !== null && !isVariantValue(input.variant)) {
    fail(`${path}.variant must be VariantValue | null`);
  }
  if (!(typeof input.variantName === "string" || input.variantName === null)) {
    fail(`${path}.variantName must be string | null`);
  }
  if (typeof input.reason !== "string" || !evaluateAllReasonSet.has(input.reason)) {
    fail(`${path}.reason is invalid`);
  }
  if (input.errorCode !== null) {
    ErrorCodeSchema.parse(input.errorCode);
  }
  if (!(typeof input.exposureTicket === "string" || input.exposureTicket === null)) {
    fail(`${path}.exposureTicket must be string | null`);
  }

  const entry: EvaluateAllEntry = {
    variant: input.variant,
    variantName: input.variantName,
    reason: input.reason as EvaluateAllReason,
    errorCode: input.errorCode as ErrorCode | null,
    exposureTicket: input.exposureTicket,
  };
  assertEvaluateAllEntryRefinements(entry, path);
  return entry;
}

function parseEvaluateAllResponse(input: unknown): EvaluateAllResponse {
  if (!isPlainObject(input)) {
    fail("EvaluateAllResponse must be an object");
  }
  assertExactKeys(input, ["evaluations"]);
  if (!isPlainObject(input.evaluations)) {
    fail("evaluations must be an object");
  }
  // Write with defineProperty so a flag key of "__proto__" becomes an own
  // property instead of hitting Object.prototype.__proto__. The map keeps a
  // normal Object.prototype so Record consumers can call hasOwnProperty /
  // toString. (zod 4.4.3 drops the "__proto__" entry entirely — see the
  // parity suite's divergence pin.)
  const evaluations: Record<string, EvaluateAllEntry> = {};
  for (const [flagKey, entry] of Object.entries(input.evaluations)) {
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
