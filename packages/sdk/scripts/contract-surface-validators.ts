/**
 * Zod-free parsers mirroring the contracts package authoring schemas.
 * Contract-generated member lists and the lockstep tests cover JSON-expressible
 * shapes (`contract-surface-structural.test.ts`), behavior and members
 * (`contract-surface-parity.test.ts`), proto-safe records
 * (`contract-surface-proto-safe.test.ts`), and TypeScript assignability
 * (`contract-surface-assignability.ts`). Cross-field `.refine()` and
 * `.superRefine()` rules are outside JSON Schema; `contract-surface-refine-parity.test.ts`
 * walks the live schemas and requires a parity fixture for every such rule.
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

export interface Schema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): ParseResult<T>;
}

export function fail(message: string): never {
  throw new Error(message);
}

export function asSchema<T>(check: (input: unknown) => T): Schema<T> {
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

// The `@__PURE__` annotations survive the tsup bundle into
// src/generated/contract-surface.js and let consumer bundlers tree-shake the
// schemas an entry never imports; the size-check budgets assume this.
const resolutionReasonSet: ReadonlySet<string> = /* @__PURE__ */ new Set(resolutionReasons);
const evaluateAllReasonSet: ReadonlySet<string> = /* @__PURE__ */ new Set(evaluateAllReasons);

const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Shape-only on purpose: contracts enforces `ErrorCode` membership on the
 * server, so shipping the code table to every client page would spend ~2 KiB
 * re-checking values the server already validated — and would make stale
 * clients reject codes a newer server legitimately added. Malformed values
 * still fail loud; the enumerated table stays available as `errorCodes` for
 * runtimes that want it.
 */
export const ErrorCodeSchema: Schema<ErrorCode> = /* @__PURE__ */ asSchema(
  (input: unknown): ErrorCode => {
    if (typeof input !== "string" || !ERROR_CODE_RE.test(input)) {
      fail("invalid ErrorCode");
    }
    return input as ErrorCode;
  },
);

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

export const ResolutionDetailsSchema: Schema<ResolutionDetails> =
  /* @__PURE__ */ asSchema(parseResolutionDetails);

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

export const DataPlaneEvaluateResponseSchema: Schema<DataPlaneEvaluateResponse> =
  /* @__PURE__ */ asSchema(parseDataPlaneEvaluateResponse);

function parsePeekEvaluateResponse(input: unknown): PeekEvaluateResponse {
  if (!isPlainObject(input)) {
    fail("PeekEvaluateResponse must be an object");
  }
  requireKeys(input, peekEvaluateRequiredKeys, "PeekEvaluateResponse");
  return { variant: parseVariantValue(input.variant, "variant") };
}

export const PeekEvaluateResponseSchema: Schema<PeekEvaluateResponse> =
  /* @__PURE__ */ asSchema(parsePeekEvaluateResponse);

function assertEvaluateAllEntryRefinements(entry: EvaluateAllEntry, path: string): void {
  if (entry.reason === "ERROR" ? entry.errorCode === null : entry.errorCode !== null) {
    fail(`${path}: errorCode is present iff reason === 'ERROR'`);
  }
  if (entry.reason !== "SPLIT" && entry.reason !== "DEFAULT" && entry.exposureTicket !== null) {
    fail(`${path}: exposureTicket is only allowed when reason is 'SPLIT' or 'DEFAULT'`);
  }
  if (entry.reason !== "SPLIT" && entry.reason !== "DEFAULT" && entry.exposureIdentity !== null) {
    fail(`${path}: exposureIdentity is only allowed when reason is 'SPLIT' or 'DEFAULT'`);
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
  /* @__PURE__ */ asSchema(parseEvaluateAllResponse);
