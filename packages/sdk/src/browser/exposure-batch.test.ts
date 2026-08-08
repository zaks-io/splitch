import { describe, expect, it } from "vitest";
import {
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
} from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { mintExposureId, pendingBodyBytes, takeBatch, type QueuedExposure } from "./exposure-batch";

function item(flagKey: string, ticket = "t"): QueuedExposure {
  return {
    flagKey,
    exposureId: "11111111-1111-4111-8111-111111111111",
    exposureTicket: ticket,
    clientTimestamp: "2026-08-08T00:00:00.000Z",
  };
}

describe("takeBatch caps in isolation (M40/M41)", () => {
  it("stops at EXPOSURE_BATCH_MAX_ITEMS even when bytes allow more (M40)", () => {
    const pending = Array.from({ length: EXPOSURE_BATCH_MAX_ITEMS + 3 }, (_, i) =>
      item(`f-${i}`, `t-${i}`),
    );
    const batch = takeBatch(pending);
    expect(batch).toHaveLength(EXPOSURE_BATCH_MAX_ITEMS);
    expect(pending).toHaveLength(3);
  });

  it("stops for the byte cap before the item cap (M41)", () => {
    const huge = "x".repeat(20_000);
    const pending = [item("a", huge), item("b", huge), item("c", huge)];
    const first = takeBatch(pending);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first.length).toBeLessThan(3);
    expect(pending.length).toBeGreaterThan(0);
    expect(pendingBodyBytes(first)).toBeLessThanOrEqual(EXPOSURE_BATCH_MAX_BODY_BYTES + 50_000);
  });

  it("still sends a single oversize item so the Worker can reject loudly", () => {
    const huge = "x".repeat(EXPOSURE_BATCH_MAX_BODY_BYTES);
    const pending = [item("solo", huge)];
    const batch = takeBatch(pending);
    expect(batch).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });
});

describe("mintExposureId (M17)", () => {
  it("throws when crypto.randomUUID is unavailable", () => {
    const original = globalThis.crypto.randomUUID;
    // @ts-expect-error intentional mutation probe
    globalThis.crypto.randomUUID = undefined;
    const logger = new FakeLogger();
    expect(() => mintExposureId(logger, "flag")).toThrow(/SDK_IDEMPOTENCY_KEY_UNAVAILABLE/);
    expect(logger.errors.length).toBeGreaterThan(0);
    globalThis.crypto.randomUUID = original;
  });
});
