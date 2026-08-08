import { describe, expect, it } from "vitest";
import {
  isRetryableExposureRejection,
  partitionExposureBatchResults,
  RETRYABLE_EXPOSURE_REJECTION_CODES,
} from "./exposure-retry";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("isRetryableExposureRejection", () => {
  it("retries only SERVICE_UNAVAILABLE", () => {
    expect([...RETRYABLE_EXPOSURE_REJECTION_CODES]).toEqual(["SERVICE_UNAVAILABLE"]);
    expect(isRetryableExposureRejection("SERVICE_UNAVAILABLE")).toBe(true);
    expect(isRetryableExposureRejection("INTERNAL_SERVER_ERROR")).toBe(false);
    expect(isRetryableExposureRejection("VALIDATION_ERROR")).toBe(false);
    expect(isRetryableExposureRejection("EXPOSURE_TICKET_INVALID")).toBe(false);
    expect(isRetryableExposureRejection(null)).toBe(false);
  });
});

describe("partitionExposureBatchResults: SDK retry cycle", () => {
  it("drops INTERNAL_SERVER_ERROR so a retry cycle does not re-send it (request count flat)", () => {
    const pending = [{ exposureId: ID_A }, { exposureId: ID_B }];
    let redeemCalls = 0;
    const redeem = (batch: readonly { exposureId: string }[]) => {
      redeemCalls += 1;
      return batch.map((item) =>
        item.exposureId === ID_A
          ? {
              exposureId: item.exposureId,
              status: "rejected" as const,
              code: "INTERNAL_SERVER_ERROR",
            }
          : { exposureId: item.exposureId, status: "accepted" as const, code: null },
      );
    };

    // Flush 1
    const first = redeem(pending);
    const afterFirst = partitionExposureBatchResults(pending, first);
    expect(afterFirst.retained.map((r) => r.exposureId)).toEqual([]);
    expect(afterFirst.completed).toHaveLength(2);

    // Flush 2 — queue empty; no further redeem
    if (afterFirst.retained.length > 0) {
      redeem(afterFirst.retained);
    }
    expect(redeemCalls).toBe(1);
  });

  it("retains SERVICE_UNAVAILABLE across flushes (request count rises)", () => {
    let pending = [{ exposureId: ID_A }];
    let redeemCalls = 0;
    const redeem = (batch: readonly { exposureId: string }[]) => {
      redeemCalls += 1;
      return batch.map((item) => ({
        exposureId: item.exposureId,
        status: "rejected" as const,
        code: "SERVICE_UNAVAILABLE",
      }));
    };

    for (let i = 0; i < 3; i++) {
      const results = redeem(pending);
      pending = partitionExposureBatchResults(pending, results).retained;
    }
    expect(redeemCalls).toBe(3);
    expect(pending).toEqual([{ exposureId: ID_A }]);
  });

  it("does not change sibling outcomes when one item is non-retryable", () => {
    const batch = [{ exposureId: ID_A }, { exposureId: ID_B }];
    const results = [
      { exposureId: ID_A, status: "rejected" as const, code: "INTERNAL_SERVER_ERROR" },
      { exposureId: ID_B, status: "accepted" as const, code: null },
    ];
    const { completed, retained } = partitionExposureBatchResults(batch, results);
    expect(retained).toEqual([]);
    expect(completed).toEqual(results);
  });
});
