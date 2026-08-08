import { describe, expect, it } from "vitest";
import {
  isRetryableExposureRejection,
  retainRetryableExposures,
  RETRYABLE_EXPOSURE_REJECTION_CODES,
} from "./exposure-retry";
import type { ErrorCode } from "./generated/contract-surface.js";
import { RETRYABLE_EXPOSURE_REJECTION_CODES as contractRetryableCodes } from "../../contracts/src/exposure-retry-codes";

const EXPOSURE_ID = "550e8400-e29b-41d4-a716-446655440001";
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("isRetryableExposureRejection", () => {
  it("derives from the named contract constant, not a free literal", () => {
    expect([...RETRYABLE_EXPOSURE_REJECTION_CODES]).toEqual([...contractRetryableCodes]);
    expect(isRetryableExposureRejection("SERVICE_UNAVAILABLE")).toBe(true);
    expect(isRetryableExposureRejection("INTERNAL_SERVER_ERROR")).toBe(false);
    expect(isRetryableExposureRejection("VALIDATION_ERROR")).toBe(false);
    expect(isRetryableExposureRejection("EXPOSURE_TICKET_INVALID")).toBe(false);
    expect(isRetryableExposureRejection("EXPOSURE_TICKET_EXPIRED")).toBe(false);
    expect(isRetryableExposureRejection("EVENT_ID_CONFLICT")).toBe(false);
  });
});

describe("retainRetryableExposures: real retry cycle", () => {
  it("drops INTERNAL_SERVER_ERROR so a retry loop issues exactly one redeem", () => {
    let redeemCalls = 0;
    let pending = [{ exposureId: EXPOSURE_ID }];

    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
      redeemCalls += 1;
      const results = pending.map((item) => ({
        exposureId: item.exposureId,
        status: "rejected" as const,
        code: "INTERNAL_SERVER_ERROR" as ErrorCode,
      }));
      pending = retainRetryableExposures(pending, results);
    }

    expect(redeemCalls).toBe(1);
    expect(pending).toEqual([]);
  });

  it("retains SERVICE_UNAVAILABLE so a retry loop keeps redeeming", () => {
    let redeemCalls = 0;
    let pending = [{ exposureId: EXPOSURE_ID }];

    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
      redeemCalls += 1;
      const results = pending.map((item) => ({
        exposureId: item.exposureId,
        status: "rejected" as const,
        code: "SERVICE_UNAVAILABLE" as ErrorCode,
      }));
      pending = retainRetryableExposures(pending, results);
    }

    expect(redeemCalls).toBe(5);
    expect(pending).toEqual([{ exposureId: EXPOSURE_ID }]);
  });

  it("does not change sibling outcomes: drops only the deterministic item", () => {
    const pending = [{ exposureId: ID_A }, { exposureId: ID_B }, { exposureId: ID_C }];
    const retained = retainRetryableExposures(pending, [
      { exposureId: ID_A, status: "accepted", code: null },
      { exposureId: ID_B, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
      { exposureId: ID_C, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(retained).toEqual([{ exposureId: ID_C }]);
  });

  it("fails loud when a rejected row carries a null code", () => {
    expect(() =>
      retainRetryableExposures(
        [{ exposureId: EXPOSURE_ID }],
        [{ exposureId: EXPOSURE_ID, status: "rejected", code: null }],
      ),
    ).toThrow(/missing a code/);
  });

  it("fails loud on an unrecognised rejection code", () => {
    expect(() =>
      retainRetryableExposures(
        [{ exposureId: EXPOSURE_ID }],
        [{ exposureId: EXPOSURE_ID, status: "rejected", code: "SOME_FUTURE_CODE" }],
      ),
    ).toThrow(/Unrecognized Exposure rejection code/);
  });

  it("fails loud on an unrecognised result status", () => {
    expect(() =>
      retainRetryableExposures(
        [{ exposureId: EXPOSURE_ID }],
        [{ exposureId: EXPOSURE_ID, status: "weird", code: null }],
      ),
    ).toThrow(/Unrecognized Exposure batch result status/);
  });
});
