/**
 * Zod-free Exposure batch validators for the public SDK contract surface.
 */

import {
  asSchema,
  ErrorCodeSchema,
  fail,
  isPlainObject,
  type Schema,
} from "./contract-surface-validators";
import type { ErrorCode } from "./generated/contract-surface-members";

/** Max items per Exposure batch (Web Event parity; contracts exposures-wire). */
export const EXPOSURE_BATCH_MAX_ITEMS = 25;
/** Max UTF-8 JSON body bytes for an Exposure batch. */
export const EXPOSURE_BATCH_MAX_BODY_BYTES = 32 * 1024;

const exposureBatchResultStatuses = ["accepted", "deduplicated", "rejected", "suppressed"] as const;
export type ExposureBatchResultStatus = (typeof exposureBatchResultStatuses)[number];

export interface ExposureBatchItem {
  exposureId: string;
  exposureTicket: string;
  clientTimestamp: string;
}

export interface ExposureBatchRequest {
  exposures: ExposureBatchItem[];
}

export interface ExposureBatchResult {
  exposureId: string;
  status: ExposureBatchResultStatus;
  code: ErrorCode | null;
}

export interface ExposureBatchResponse {
  results: ExposureBatchResult[];
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
