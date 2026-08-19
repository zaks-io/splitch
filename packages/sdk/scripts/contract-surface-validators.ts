/**
 * Zod-free parsers mirroring the contracts package authoring schemas.
 * Every enum member and required-key list they check against is generated from
 * contracts by `scripts/generate-contract-surface.mjs`; the parsing logic and
 * the object shapes in `contract-surface-types.ts` are hand-written and held in
 * lockstep by `contract-surface-structural.test.ts` (shape),
 * `contract-surface-parity.test.ts` (behavior),
 * `contract-surface-proto-safe.test.ts` (derived runtime refinements), and
 * `contract-surface-assignability.ts` (types).
 *
 * Accepted domain is JSON-only by construction today: every `parse()` call
 * takes `await response.json()`, and these schemas are not exported on a
 * public `./browser` subpath. `isVariantValue` is wider than `z.number()` /
 * `z.record()` (it accepts NaN, Infinity, Date, Map, class instances); that
 * gap is unreachable until a non-JSON caller appears.
 *
 * Response parsers build results field-by-field from known keys: an unknown
 * key means the server is ahead of this mirror, not a malformed payload.
 * Rejecting it would surface as SDK_TRANSPORT_PARSE and collapse every flag
 * to the caller's default.
 */

import type {
  DataPlaneEvaluateResponse,
  ErrorCode,
  EvaluateAllEntry,
  EvaluateAllReason,
  EvaluateAllResponse,
  PeekEvaluateResponse,
  ResolutionDetails,
  ResolutionReason,
  VariantValue,
} from "./contract-surface-types";
import {
  dataPlaneEvaluateRequiredKeys,
  errorCodes,
  evaluateAllEntryRequiredKeys,
  evaluateAllReasons,
  evaluateAllResponseRequiredKeys,
  peekEvaluateRequiredKeys,
  resolutionDetailsRequiredKeys,
  resolutionReasons,
} from "./generated/contract-surface-members";

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
} from "./contract-surface-types";

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

const OWN_PROTO_KEY = "__proto__";
const OWN_PROTO_KEY_MESSAGE = `must not contain a "${OWN_PROTO_KEY}" key`;

function rejectOwnProtoKey(value: Record<string, unknown>): void {
  if (Object.hasOwn(value, OWN_PROTO_KEY)) {
    fail(OWN_PROTO_KEY_MESSAGE);
  }
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
  requireKeys(input, resolutionDetailsRequiredKeys, "ResolutionDetails");
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
  requireKeys(input, dataPlaneEvaluateRequiredKeys, "DataPlaneEvaluateResponse");
  if (input.variant !== null && !isVariantValue(input.variant)) {
    fail("variant must be VariantValue | null");
  }
  return { variant: input.variant as VariantValue | null };
}

export const DataPlaneEvaluateResponseSchema: Schema<DataPlaneEvaluateResponse> = asSchema(
  parseDataPlaneEvaluateResponse,
);

function parsePeekEvaluateResponse(input: unknown): PeekEvaluateResponse {
  if (!isPlainObject(input)) {
    fail("PeekEvaluateResponse must be an object");
  }
  requireKeys(input, peekEvaluateRequiredKeys, "PeekEvaluateResponse");
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
  if (entry.reason !== "SPLIT" && entry.exposureIdentity !== null) {
    fail(`${path}: exposureIdentity is only allowed when reason === 'SPLIT'`);
  }
  if ((entry.exposureTicket === null) !== (entry.exposureIdentity === null)) {
    fail(`${path}: exposureIdentity is present iff exposureTicket is present`);
  }
}

function nullableString(value: unknown, path: string): string | null {
  if (!(typeof value === "string" || value === null)) {
    fail(`${path} must be string | null`);
  }
  return value;
}

function parseEvaluateAllEntry(input: unknown, path: string): EvaluateAllEntry {
  if (!isPlainObject(input)) {
    fail(`${path} must be an object`);
  }
  requireKeys(input, evaluateAllEntryRequiredKeys, path);
  if (input.variant !== null && !isVariantValue(input.variant)) {
    fail(`${path}.variant must be VariantValue | null`);
  }
  if (typeof input.reason !== "string" || !evaluateAllReasonSet.has(input.reason)) {
    fail(`${path}.reason is invalid`);
  }
  if (input.errorCode !== null) {
    ErrorCodeSchema.parse(input.errorCode);
  }

  const entry: EvaluateAllEntry = {
    variant: input.variant as VariantValue | null,
    variantName: nullableString(input.variantName, `${path}.variantName`),
    reason: input.reason as EvaluateAllReason,
    errorCode: input.errorCode as ErrorCode | null,
    exposureIdentity: nullableString(input.exposureIdentity, `${path}.exposureIdentity`),
    exposureTicket: nullableString(input.exposureTicket, `${path}.exposureTicket`),
  };
  assertEvaluateAllEntryRefinements(entry, path);
  return entry;
}

function parseEvaluateAllResponse(input: unknown): EvaluateAllResponse {
  if (!isPlainObject(input)) {
    fail("EvaluateAllResponse must be an object");
  }
  requireKeys(input, evaluateAllResponseRequiredKeys, "EvaluateAllResponse");
  if (!isPlainObject(input.evaluations)) {
    fail("evaluations must be an object");
  }
  // Match the Worker contract's fail-loud refusal before zod 4.4.3 or object
  // assignment can silently drop an own "__proto__" Flag Key.
  rejectOwnProtoKey(input.evaluations);
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
