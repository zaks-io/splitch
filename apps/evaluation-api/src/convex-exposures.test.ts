import { describe, expect, it, vi } from "vitest";
import {
  completedHoldover,
  EXPOSURE_ID,
  INSTALLATION_ID,
  provider,
  readOnlyAssignments,
  requestArgs,
  resolver,
  saltStore,
} from "./convex-exposures-test-fixture";
import { makeConvexExposuresHandler } from "./convex-exposures";
import { RecordingExposureIngestSink } from "./exposure-redemption";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";

describe("Convex server Exposure verification", () => {
  it("verifies the bounded batch once and preserves result order", async () => {
    const resolveBatch = vi.fn(async (_principal: unknown, _items: readonly unknown[]) => [
      { status: "installation_not_found" as const },
      { status: "configuration_not_found" as const },
    ]);
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: { resolveBatch },
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
    });
    const args = requestArgs();
    const body = (args.input as { body: { exposures: Array<{ exposureId: string }> } }).body;
    body.exposures.push({
      ...body.exposures[0],
      exposureId: "00000000-0000-4000-8000-000000000003",
    });

    const response = await handler(args);

    expect(resolveBatch).toHaveBeenCalledTimes(1);
    expect(resolveBatch.mock.calls[0]?.[1]).toHaveLength(2);
    expect(await response.json()).toEqual({
      results: [
        expect.objectContaining({
          exposureId: EXPOSURE_ID,
          code: "CONVEX_INSTALLATION_NOT_FOUND",
        }),
        expect.objectContaining({
          exposureId: "00000000-0000-4000-8000-000000000003",
          code: "STALE_CONFIGURATION",
        }),
      ],
    });
  });

  it("recomputes the Variant, hashes identity, ingests, and deduplicates retries", async () => {
    const sink = new RecordingExposureIngestSink();
    const holdoverWrites: unknown[] = [];
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(holdoverWrites),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });
    const args = requestArgs();

    const accepted = await handler(args);
    const duplicate = await handler(args);

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      results: [{ exposureId: EXPOSURE_ID, status: "accepted" }],
    });
    expect(await duplicate.json()).toEqual({
      results: [{ exposureId: EXPOSURE_ID, status: "deduplicated" }],
    });
    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]).toMatchObject({
      eventId: EXPOSURE_ID,
      exposureAt: "2026-08-25T12:00:00.000Z",
      sourceId: `convex:${INSTALLATION_ID}`,
      variantName: "treatment",
    });
    expect(sink.writes[0]?.targetingKeyHash).not.toContain("user@example.com");
    expect(holdoverWrites).toHaveLength(2);
    expect(holdoverWrites[0]).toMatchObject({
      appId: "app_1",
      experimentId: "exp_1",
      idType: "user",
      runId: "run_1",
      variant: "treatment",
    });
    expect(JSON.stringify(holdoverWrites[0])).not.toContain("user@example.com");
  });

  it("settles duplicate Exposure ids in request order after one batch verification", async () => {
    const sink = new RecordingExposureIngestSink();
    const resolveBatch = vi.fn(resolver().resolveBatch);
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: { resolveBatch },
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });
    const args = requestArgs();
    const body = (args.input as { body: { exposures: Array<Record<string, unknown>> } }).body;
    body.exposures.push({ ...body.exposures[0] });

    expect(await (await handler(args)).json()).toEqual({
      results: [
        { exposureId: EXPOSURE_ID, status: "accepted" },
        { exposureId: EXPOSURE_ID, status: "deduplicated" },
      ],
    });
    expect(resolveBatch).toHaveBeenCalledTimes(1);
    expect(sink.writes).toHaveLength(1);
  });
});

describe("Convex server Exposure validation", () => {
  it("rejects a Variant assertion that the shared evaluator cannot reproduce", async () => {
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      // Pinned like every sibling: the fixture's exposureAt is a fixed instant,
      // so a real clock walks it out of the 24-hour delivery window and the
      // rejection under test turns into a VALIDATION_ERROR a day later.
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });
    const args = requestArgs();
    const body = (args.input as { body: { exposures: Array<{ variantName: string }> } }).body;
    body.exposures[0] = { ...body.exposures[0], variantName: "control" };

    expect(await (await handler(args)).json()).toEqual({
      results: [
        {
          exposureId: EXPOSURE_ID,
          status: "rejected",
          code: "STALE_CONFIGURATION",
          message: "STALE_CONFIGURATION",
          retryable: false,
        },
      ],
    });
  });

  it("rejects Exposures outside the bounded 24-hour delivery window", async () => {
    const sink = new RecordingExposureIngestSink();
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-26T12:00:00.001Z"),
    });

    expect(await (await handler(requestArgs())).json()).toEqual({
      results: [
        {
          exposureId: EXPOSURE_ID,
          status: "rejected",
          code: "VALIDATION_ERROR",
          message: "VALIDATION_ERROR",
          retryable: false,
        },
      ],
    });
    expect(sink.writes).toHaveLength(0);
  });

  it("accepts delayed delivery against an immutable ended Run", async () => {
    const sink = new RecordingExposureIngestSink();
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver({ endedAt: "2026-08-25T12:00:00.500Z" }),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T13:00:00.000Z"),
    });

    expect(await (await handler(requestArgs())).json()).toEqual({
      results: [{ exposureId: EXPOSURE_ID, status: "accepted" }],
    });
    expect(sink.writes).toHaveLength(1);
  });

  it("rejects an encounter outside the immutable Run interval", async () => {
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver({ endedAt: "2026-08-25T11:59:59.999Z" }),
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T13:00:00.000Z"),
    });

    expect(await (await handler(requestArgs())).json()).toEqual({
      results: [
        {
          exposureId: EXPOSURE_ID,
          status: "rejected",
          code: "VALIDATION_ERROR",
          message: "VALIDATION_ERROR",
          retryable: false,
        },
      ],
    });
  });
});
