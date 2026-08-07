import { describe, expect, it } from "vitest";
import {
  EXPOSURE_REDEMPTION_CLAIM_TTL_MS,
  MemoryExposureRedemptionClaimStore,
} from "./exposure-redemption-claim";
import { APP_B, ENV_B, EXPOSURE_ID_A, EXPOSURE_ID_B } from "./exposures-test-fixtures";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

const NOW = 1_700_000_000_000;

describe("MemoryExposureRedemptionClaimStore tenant scoping", () => {
  it("scopes ticket-fingerprint claims by App so identical fingerprints do not collide", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "shared-fingerprint",
      nowMs: NOW,
    });

    const otherApp = await claims.claim({
      appId: APP_B,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_B,
      ticketFingerprint: "shared-fingerprint",
      nowMs: NOW,
    });
    expect(otherApp).toEqual({ status: "acquired" });
  });

  it("scopes ticket-fingerprint claims by Environment", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "shared-fingerprint",
      nowMs: NOW,
    });

    const otherEnv = await claims.claim({
      appId: APP_ID,
      environmentId: ENV_B,
      exposureId: EXPOSURE_ID_B,
      ticketFingerprint: "shared-fingerprint",
      nowMs: NOW,
    });
    expect(otherEnv).toEqual({ status: "acquired" });
  });
});

describe("MemoryExposureRedemptionClaimStore atomic claim semantics", () => {
  it("acquires once, resumes the same pending ID, and deduplicates a fresh ID on the same ticket", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const first = await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });
    expect(first).toEqual({ status: "acquired" });

    const resume = await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });
    expect(resume).toEqual({ status: "resume" });

    const freshId = await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_B,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });
    expect(freshId).toEqual({ status: "deduplicated" });
  });

  it("binds a fresh ID on ticket dedup so a different ticket with that ID conflicts", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });
    await claims.acknowledge({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });

    const bound = await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_B,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });
    expect(bound).toEqual({ status: "deduplicated" });

    const conflict = await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_B,
      ticketFingerprint: "ticket-b",
      nowMs: NOW,
    });
    expect(conflict).toEqual({ status: "conflict" });
  });

  it("lets an exact-ID retry after acknowledge failure still resume the pending claim", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });

    // Simulate ingest success without acknowledge — pending remains.
    const retry = await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });
    expect(retry).toEqual({ status: "resume" });

    await expect(
      claims.acknowledge({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: EXPOSURE_ID_A,
        ticketFingerprint: "ticket-a",
        nowMs: NOW,
      }),
    ).resolves.toEqual({ status: "accepted" });

    await expect(
      claims.claim({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: EXPOSURE_ID_A,
        ticketFingerprint: "ticket-a",
        nowMs: NOW,
      }),
    ).resolves.toEqual({ status: "deduplicated" });
  });

  it("does not resurrect a still-valid ticket after claim TTL when clock advances past expiry", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });
    await claims.acknowledge({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: EXPOSURE_ID_A,
      ticketFingerprint: "ticket-a",
      nowMs: NOW,
    });

    // Within the claim TTL window the ticket remains owned.
    await expect(
      claims.claim({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: EXPOSURE_ID_B,
        ticketFingerprint: "ticket-a",
        nowMs: NOW + EXPOSURE_REDEMPTION_CLAIM_TTL_MS - 1,
      }),
    ).resolves.toEqual({ status: "deduplicated" });
  });
});
