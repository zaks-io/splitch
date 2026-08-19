import { describe, expect, it } from "vitest";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES as contractExposureBatchMaxBodyBytes,
  EXPOSURE_BATCH_MAX_ITEMS as contractExposureBatchMaxItems,
} from "../../contracts/src/leaves/exposures-wire";
import {
  ExposureBatchRequestSchema as ZodExposureBatchRequestSchema,
  ExposureBatchResponseSchema as ZodExposureBatchResponseSchema,
} from "../../contracts/src/sdk-data-plane-surface";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES as compiledExposureBatchMaxBodyBytes,
  EXPOSURE_BATCH_MAX_ITEMS as compiledExposureBatchMaxItems,
  ExposureBatchRequestSchema,
  ExposureBatchResponseSchema,
} from "./generated/contract-surface.js";

type ParseResult = { success: true; data: unknown } | { success: false; error?: unknown };
type AnySchema = { safeParse: (input: unknown) => ParseResult };

function expectParity(compiled: AnySchema, zod: AnySchema, input: unknown, ok: boolean) {
  const compiledResult = compiled.safeParse(input);
  const zodResult = zod.safeParse(input);
  expect(compiledResult.success).toBe(ok);
  expect(zodResult.success).toBe(ok);
  if (ok && compiledResult.success && zodResult.success) {
    expect(compiledResult.data).toEqual(zodResult.data);
  }
}

describe("contract-surface exposure batch parity", () => {
  it("exposure batch caps match contracts exactly", () => {
    expect(compiledExposureBatchMaxItems).toBe(contractExposureBatchMaxItems);
    expect(compiledExposureBatchMaxBodyBytes).toBe(contractExposureBatchMaxBodyBytes);
  });

  it("ExposureBatchRequestSchema matches Zod", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const row of [
      {
        input: {
          exposures: [
            {
              exposureId: id,
              exposureTicket: "ticket",
              clientTimestamp: "2026-08-08T00:00:00.000Z",
            },
          ],
        },
        ok: true,
      },
      {
        input: {
          exposures: [
            {
              exposureId: "not-a-uuid",
              exposureTicket: "ticket",
              clientTimestamp: "2026-08-08T00:00:00.000Z",
            },
          ],
        },
        ok: false,
      },
      { input: { exposures: [] }, ok: false },
    ]) {
      expectParity(ExposureBatchRequestSchema, ZodExposureBatchRequestSchema, row.input, row.ok);
    }
  });

  it("ExposureBatchResponseSchema matches Zod", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const row of [
      {
        input: { results: [{ exposureId: id, status: "accepted", code: null }] },
        ok: true,
      },
      {
        input: {
          results: [{ exposureId: id, status: "rejected", code: "EXPOSURE_TICKET_INVALID" }],
        },
        ok: true,
      },
      {
        input: { results: [{ exposureId: id, status: "accepted", code: "VALIDATION_ERROR" }] },
        ok: false,
      },
    ]) {
      expectParity(ExposureBatchResponseSchema, ZodExposureBatchResponseSchema, row.input, row.ok);
    }
  });
});
