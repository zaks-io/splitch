/**
 * Zod-free Exposure batch validators for the public SDK contract surface.
 */

import {
  type ErrorCode,
  EXPOSURE_BATCH_MAX_ITEMS,
  type ExposureBatchItem,
  type ExposureBatchRequest,
  type ExposureBatchResponse,
  type ExposureBatchResult,
  type ExposureBatchResultStatus,
  exposureBatchResultStatuses,
} from "./contract-surface-enums";
import { ErrorCodeSchema } from "./contract-surface-validators";

export type {
  ExposureBatchItem,
  ExposureBatchRequest,
  ExposureBatchResponse,
  ExposureBatchResult,
  ExposureBatchResultStatus,
} from "./contract-surface-enums";
export { EXPOSURE_BATCH_MAX_BODY_BYTES, EXPOSURE_BATCH_MAX_ITEMS } from "./contract-surface-enums";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Zod's `datetime({ offset: true })`: requires a timezone offset (`Z` or ±HH:MM).
const OFFSET_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const exposureBatchResultStatusSet: ReadonlySet<string> = new Set(exposureBatchResultStatuses);

function parseUuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    fail(`${path} must be a UUID`);
  }
  return value;
}

function parseExposureBatchResult(input: unknown, path: string): ExposureBatchResult {
  if (!isPlainObject(input)) {
    fail(`${path} must be an object`);
  }
  assertExactKeys(input, ["exposureId", "status", "code"]);
  const exposureId = parseUuid(input.exposureId, `${path}.exposureId`);
  if (typeof input.status !== "string" || !exposureBatchResultStatusSet.has(input.status)) {
    fail(`${path}.status is invalid`);
  }
  if (input.code !== null) {
    ErrorCodeSchema.parse(input.code);
  }
  const row: ExposureBatchResult = {
    exposureId,
    status: input.status as ExposureBatchResultStatus,
    code: input.code as ErrorCode | null,
  };
  if (row.status === "rejected" ? row.code === null : row.code !== null) {
    fail(`${path}: code is present iff status === 'rejected'`);
  }
  return row;
}

function parseExposureBatchResponse(input: unknown): ExposureBatchResponse {
  if (!isPlainObject(input)) {
    fail("ExposureBatchResponse must be an object");
  }
  assertExactKeys(input, ["results"]);
  if (!Array.isArray(input.results)) {
    fail("results must be an array");
  }
  return {
    results: input.results.map((row, index) => parseExposureBatchResult(row, `results.${index}`)),
  };
}

export const ExposureBatchResponseSchema: Schema<ExposureBatchResponse> = asSchema(
  parseExposureBatchResponse,
);

function parseExposureBatchRequest(input: unknown): ExposureBatchRequest {
  if (!isPlainObject(input)) {
    fail("ExposureBatchRequest must be an object");
  }
  assertExactKeys(input, ["exposures"]);
  if (!Array.isArray(input.exposures)) {
    fail("exposures must be an array");
  }
  if (input.exposures.length < 1 || input.exposures.length > EXPOSURE_BATCH_MAX_ITEMS) {
    fail(`exposures must contain 1..${EXPOSURE_BATCH_MAX_ITEMS} items`);
  }
  const exposures: ExposureBatchItem[] = input.exposures.map((raw, index) => {
    const path = `exposures.${index}`;
    if (!isPlainObject(raw)) {
      fail(`${path} must be an object`);
    }
    assertExactKeys(raw, ["exposureId", "exposureTicket", "clientTimestamp"]);
    const exposureId = parseUuid(raw.exposureId, `${path}.exposureId`);
    if (typeof raw.exposureTicket !== "string" || raw.exposureTicket.length === 0) {
      fail(`${path}.exposureTicket must be a non-empty string`);
    }
    if (typeof raw.clientTimestamp !== "string" || !OFFSET_DATETIME_RE.test(raw.clientTimestamp)) {
      fail(`${path}.clientTimestamp must be an offset datetime`);
    }
    return {
      exposureId,
      exposureTicket: raw.exposureTicket,
      clientTimestamp: raw.clientTimestamp,
    };
  });
  return { exposures };
}

export const ExposureBatchRequestSchema: Schema<ExposureBatchRequest> =
  asSchema(parseExposureBatchRequest);
