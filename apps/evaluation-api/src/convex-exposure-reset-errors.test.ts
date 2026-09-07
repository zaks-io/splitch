import {
  makeIdentitySaltStore,
  makeMemoryAppIdentityStore,
  mintInitialAppIdentityRecord,
} from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { makeConvexExposuresHandler } from "./convex-exposures";
import {
  completedHoldover,
  EXPOSURE_ID,
  provider,
  readOnlyAssignments,
  requestArgs,
  resolver,
} from "./convex-exposures-test-fixture";
import { RecordingExposureIngestSink } from "./exposure-redemption";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";

describe("integration Exposure salt failures", () => {
  it.each([true, false])("classifies a salt failure with reset blocked=%s", async (blocked) => {
    const rootSecret = "integration-reset-error-test";
    const record = mintInitialAppIdentityRecord(rootSecret);
    const identities = makeMemoryAppIdentityStore(new Map([["app_1", record]]));
    const source = makeIdentitySaltStore({ rootSecret, identityStore: identities });
    const fault = new Error("unexpected salt failure");
    const sink = new RecordingExposureIngestSink();
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: {
        ...source,
        async saltFor(appId, version) {
          if (!blocked) throw fault;
          await identities.save(appId, {
            ...record,
            lifecycle: {
              ...record.lifecycle,
              state: "blocked",
              trafficBlocked: true,
              resetId: "reset-test",
            },
          });
          return source.saltFor(appId, version);
        },
      },
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });
    const pending = handler(requestArgs());
    if (blocked) {
      expect(await (await pending).json()).toEqual({
        results: [
          {
            exposureId: EXPOSURE_ID,
            status: "rejected",
            code: "SERVICE_UNAVAILABLE",
            message: "SERVICE_UNAVAILABLE",
            retryable: true,
          },
        ],
      });
    } else {
      await expect(pending).rejects.toBe(fault);
    }
    expect(sink.writes).toEqual([]);
  });
});
