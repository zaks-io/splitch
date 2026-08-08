import { describe, expect, it } from "vitest";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import { EXPOSURE_REDEMPTION_CLAIM_TTL_MS } from "./exposure-redemption-claim-core";
import { APP_B, ENV_B, EXPOSURE_ID_A, EXPOSURE_ID_B } from "./exposures-test-fixtures";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

const NOW = 1_700_000_000_000;
const base = {
  appId: APP_ID,
  environmentId: ENVIRONMENT_ID,
  ticketFingerprint: "ticket-a",
  nowMs: NOW,
};

describe("MemoryExposureRedemptionClaimStore tenant scoping", () => {
  it("scopes ticket-fingerprint claims by App so identical fingerprints do not collide", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(
      claims.claim({
        ...base,
        appId: APP_B,
        exposureId: EXPOSURE_ID_B,
        ticketFingerprint: "shared-fingerprint",
      }),
    ).resolves.toEqual({ status: "acquired" });
  });

  it("scopes ticket-fingerprint claims by Environment", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(
      claims.claim({
        ...base,
        environmentId: ENV_B,
        exposureId: EXPOSURE_ID_B,
        ticketFingerprint: "shared-fingerprint",
      }),
    ).resolves.toEqual({ status: "acquired" });
  });
});

describe("MemoryExposureRedemptionClaimStore atomic claim semantics", () => {
  it("returns busy for a concurrent pending claim and never false-deduplicates a fresh ID", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_A })).resolves.toEqual({
      status: "acquired",
    });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_A })).resolves.toEqual({
      status: "busy",
    });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_B })).resolves.toEqual({
      status: "busy",
    });
  });

  it("releases a pending claim so a later attempt can acquire after ingest failure", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.release({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_B })).resolves.toEqual({
      status: "acquired",
    });
  });

  it("resume_ack only after sealed; acknowledge without seal fails loud", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(claims.acknowledge({ ...base, exposureId: EXPOSURE_ID_A })).rejects.toThrow(
      /sealed before acknowledge/,
    );
    await claims.markSealed({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_A })).resolves.toEqual({
      status: "resume_ack",
    });
    await expect(claims.acknowledge({ ...base, exposureId: EXPOSURE_ID_A })).resolves.toEqual({
      status: "accepted",
    });
  });

  it("binds a fresh ID only after sealed/accepted so Ticket B with that ID conflicts", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.markSealed({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.acknowledge({ ...base, exposureId: EXPOSURE_ID_A });

    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_B })).resolves.toEqual({
      status: "deduplicated",
    });
    await expect(
      claims.claim({ ...base, exposureId: EXPOSURE_ID_B, ticketFingerprint: "ticket-b" }),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("throws when acknowledge targets a missing claim", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await expect(claims.acknowledge({ ...base, exposureId: EXPOSURE_ID_A })).rejects.toThrow(
      /missing or mismatched at acknowledge/,
    );
  });

  it("keeps ownership inside the claim TTL window", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.markSealed({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.acknowledge({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(
      claims.claim({
        ...base,
        exposureId: EXPOSURE_ID_B,
        nowMs: NOW + EXPOSURE_REDEMPTION_CLAIM_TTL_MS - 1,
      }),
    ).resolves.toEqual({ status: "deduplicated" });
  });
});
