import { describe, expect, it, vi } from "vitest";
import { makeConvexExposuresHandler } from "./convex-exposures";
import {
  completedHoldover,
  EXPOSURE_ID,
  provider,
  readOnlyAssignments,
  requestArgs,
  resolver,
  saltStore,
} from "./convex-exposures-test-fixture";
import { RecordingExposureIngestSink } from "./exposure-redemption";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";

describe("Convex server Exposure hot-path concurrency", () => {
  it("resolves configuration while App identity admission is in flight", async () => {
    let releaseAdmission: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let admissionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    const resolveBatch = vi.fn(resolver().resolveBatch);
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: { resolveBatch },
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: {
        ...saltStore(),
        async currentKeyVersion() {
          admissionStarted?.();
          await admission;
          return "v1";
        },
      },
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });

    const response = handler(requestArgs());
    await started;
    try {
      expect(resolveBatch).toHaveBeenCalledOnce();
    } finally {
      releaseAdmission?.();
    }

    expect((await response).status).toBe(202);
  });

  it("preserves admission failure when configuration resolution also fails", async () => {
    const resolveBatch = vi.fn(async () => {
      throw new Error("Control Plane unavailable");
    });
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: { resolveBatch },
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: {
        ...saltStore(),
        async currentKeyVersion() {
          throw new Error("App identity unavailable");
        },
      },
    });

    const response = await handler(requestArgs());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "App identity reset is in progress",
    });
    expect(resolveBatch).toHaveBeenCalledOnce();
  });

  it("fails admission without waiting for stalled configuration resolution", async () => {
    const resolveBatch = vi.fn(() => new Promise<never>(() => {}));
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: { resolveBatch },
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: {
        ...saltStore(),
        async currentKeyVersion() {
          throw new Error("App identity unavailable");
        },
      },
    });

    const response = await handler(requestArgs());

    expect(response.status).toBe(503);
    expect(resolveBatch).toHaveBeenCalledOnce();
  });
});

describe("Convex server Exposure confirmation", () => {
  it("confirms an acquired claim while ensuring its holdover write", async () => {
    let releaseConfirmation: (() => void) | undefined;
    const confirmation = new Promise<void>((resolve) => {
      releaseConfirmation = resolve;
    });
    let confirmationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      confirmationStarted = resolve;
    });
    const holdoverEnsure = vi.fn(async () => ({ status: "completed" as const }));
    const claims = {
      async claim() {
        return { status: "acquired" as const };
      },
      async release() {},
      async markSealed() {
        confirmationStarted?.();
        await confirmation;
      },
      async acknowledge() {
        return { status: "accepted" as const };
      },
    };
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: claims,
      holdoverWrite: { ensure: holdoverEnsure },
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });

    const response = handler(requestArgs());
    await started;
    try {
      expect(holdoverEnsure).toHaveBeenCalledOnce();
    } finally {
      releaseConfirmation?.();
    }

    expect(await (await response).json()).toEqual({
      results: [{ exposureId: EXPOSURE_ID, status: "accepted" }],
    });
  });
});

describe("Convex server Exposure confirmation failures", () => {
  it.each([
    ["completed", "SERVICE_UNAVAILABLE", true],
    ["poisoned", "INTERNAL_SERVER_ERROR", false],
    ["suppressed", "CONVEX_INSTALLATION_NOT_FOUND", false],
  ] as const)(
    "surfaces %s holdover status when claim confirmation fails",
    async (holdoverStatus, code, retryable) => {
      const holdoverEnsure = vi.fn(async () => ({ status: holdoverStatus }));
      const handler = makeConvexExposuresHandler({
        provider: provider(),
        assignmentStore: readOnlyAssignments(),
        convexConfigurationResolver: resolver(),
        exposureIngestSink: new RecordingExposureIngestSink(),
        exposureRedemptionClaims: {
          async claim() {
            return { status: "acquired" as const };
          },
          async release() {},
          async markSealed() {
            throw new Error("claim confirmation failed");
          },
          async acknowledge() {
            return { status: "accepted" as const };
          },
        },
        holdoverWrite: { ensure: holdoverEnsure },
        saltStore: saltStore(),
        now: () => new Date("2026-08-25T12:00:01.000Z"),
      });

      const response = await handler(requestArgs());

      expect(await response.json()).toEqual({
        results: [
          {
            exposureId: EXPOSURE_ID,
            status: "rejected",
            code,
            message: code,
            retryable,
          },
        ],
      });
      expect(holdoverEnsure).toHaveBeenCalledOnce();
    },
  );
});
