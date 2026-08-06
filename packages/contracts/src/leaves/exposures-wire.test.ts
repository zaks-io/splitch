import { describe, expect, it } from "vitest";
import {
  EXPOSURE_BATCH_MAX_ITEMS,
  ExposureBatchRequestSchema,
  ExposureBatchResponseSchema,
} from "./exposures-wire";

describe("ExposureBatchRequestSchema", () => {
  const item = {
    exposureId: "550e8400-e29b-41d4-a716-446655440000",
    exposureTicket: "payload.signature",
    clientTimestamp: "2026-07-03T00:00:00.000Z",
  };

  it("accepts a non-empty batch within the item cap", () => {
    const parsed = ExposureBatchRequestSchema.parse({ exposures: [item] });
    expect(parsed.exposures).toHaveLength(1);
  });

  it("rejects an empty batch and an oversize item count", () => {
    expect(ExposureBatchRequestSchema.safeParse({ exposures: [] }).success).toBe(false);
    expect(
      ExposureBatchRequestSchema.safeParse({
        exposures: Array.from({ length: EXPOSURE_BATCH_MAX_ITEMS + 1 }, (_, i) => ({
          ...item,
          exposureId: `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, "0")}`,
        })),
      }).success,
    ).toBe(false);
  });

  it("rejects a non-UUID exposureId and unknown fields", () => {
    expect(
      ExposureBatchRequestSchema.safeParse({
        exposures: [{ ...item, exposureId: "not-a-uuid" }],
      }).success,
    ).toBe(false);
    expect(
      ExposureBatchRequestSchema.safeParse({
        exposures: [{ ...item, extra: true }],
      }).success,
    ).toBe(false);
  });
});

describe("ExposureBatchResponseSchema", () => {
  it("requires code only when status is rejected", () => {
    expect(
      ExposureBatchResponseSchema.safeParse({
        results: [
          {
            exposureId: "550e8400-e29b-41d4-a716-446655440000",
            status: "accepted",
            code: null,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      ExposureBatchResponseSchema.safeParse({
        results: [
          {
            exposureId: "550e8400-e29b-41d4-a716-446655440000",
            status: "rejected",
            code: "EXPOSURE_TICKET_INVALID",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      ExposureBatchResponseSchema.safeParse({
        results: [
          {
            exposureId: "550e8400-e29b-41d4-a716-446655440000",
            status: "accepted",
            code: "EXPOSURE_TICKET_INVALID",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
