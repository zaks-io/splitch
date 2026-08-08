import { describe, expect, it } from "vitest";
import {
  exposureRedemptionClaimScopeName,
  MemoryExposureRedemptionClaimStore,
  parseAcknowledgeOutcome,
  parseClaimOutcome,
  parseOk,
} from "./exposure-redemption-claim";
import {
  applyExposureRedemptionMarkSealed,
  EXPOSURE_REDEMPTION_CLAIM_TTL_MS,
  EXPOSURE_REDEMPTION_PENDING_LEASE_MS,
} from "./exposure-redemption-claim-core";
import { ExposureRedemptionClaimFault } from "./exposure-redemption-claim-fault";
import { APP_B, ENV_B, EXPOSURE_ID_A, EXPOSURE_ID_B } from "./exposures-test-fixtures";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

const NOW = 1_700_000_000_000;
const base = {
  appId: APP_ID,
  environmentId: ENVIRONMENT_ID,
  ticketFingerprint: "shared-fingerprint",
  nowMs: NOW,
};

describe("MemoryExposureRedemptionClaimStore tenant scoping", () => {
  it("scopes identical exposureId+fingerprint by App", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_A })).resolves.toEqual({
      status: "acquired",
    });
    await expect(
      claims.claim({ ...base, appId: APP_B, exposureId: EXPOSURE_ID_A }),
    ).resolves.toEqual({ status: "acquired" });
  });

  it("scopes identical exposureId+fingerprint by Environment", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_A })).resolves.toEqual({
      status: "acquired",
    });
    await expect(
      claims.claim({ ...base, environmentId: ENV_B, exposureId: EXPOSURE_ID_A }),
    ).resolves.toEqual({ status: "acquired" });
  });

  it("builds the DO scope name from both App and Environment", () => {
    expect(exposureRedemptionClaimScopeName(APP_ID, ENVIRONMENT_ID)).toBe(
      `${APP_ID}\u001f${ENVIRONMENT_ID}`,
    );
    expect(exposureRedemptionClaimScopeName(APP_ID, ENVIRONMENT_ID)).not.toBe(
      exposureRedemptionClaimScopeName(APP_ID, ENV_B),
    );
    expect(exposureRedemptionClaimScopeName(APP_ID, ENVIRONMENT_ID)).not.toBe(APP_ID);
  });
});

describe("MemoryExposureRedemptionClaimStore claim lifecycle", () => {
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

  it("does not release a sealed claim (committed ownership stays)", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.markSealed({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.release({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_A })).resolves.toEqual({
      status: "resume_ack",
    });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_B })).resolves.toEqual({
      status: "deduplicated",
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

  it("keeps a rebound exposureId on deduplicated forever (never resume_ack/accepted)", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.markSealed({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_B })).resolves.toEqual({
      status: "deduplicated",
    });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_B })).resolves.toEqual({
      status: "deduplicated",
    });
  });
});

describe("MemoryExposureRedemptionClaimStore lease and guards", () => {
  it("throws when acknowledge or markSealed targets a missing claim", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await expect(claims.acknowledge({ ...base, exposureId: EXPOSURE_ID_A })).rejects.toThrow(
      /missing or mismatched at acknowledge/,
    );
    await expect(claims.markSealed({ ...base, exposureId: EXPOSURE_ID_A })).rejects.toThrow(
      /missing or mismatched at markSealed/,
    );
  });

  it("uses a short pending lease distinct from the claim TTL", async () => {
    expect(EXPOSURE_REDEMPTION_PENDING_LEASE_MS).toBeLessThan(60_000);
    expect(EXPOSURE_REDEMPTION_PENDING_LEASE_MS).toBeLessThan(EXPOSURE_REDEMPTION_CLAIM_TTL_MS);
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(
      claims.claim({
        ...base,
        exposureId: EXPOSURE_ID_B,
        nowMs: NOW + EXPOSURE_REDEMPTION_PENDING_LEASE_MS + 1,
      }),
    ).resolves.toEqual({ status: "acquired" });
  });

  it("keeps sealed ownership inside the claim TTL window", async () => {
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

  it("expires exposure and ticket records on read after their expiresAt", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.markSealed({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(
      claims.claim({
        ...base,
        exposureId: EXPOSURE_ID_A,
        nowMs: NOW + EXPOSURE_REDEMPTION_CLAIM_TTL_MS + 1,
      }),
    ).resolves.toEqual({ status: "acquired" });
  });

  it("markSealed updates the ticket binding so a fresh ID deduplicates", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    await claims.claim({ ...base, exposureId: EXPOSURE_ID_A });
    await claims.markSealed({ ...base, exposureId: EXPOSURE_ID_A });
    await expect(claims.claim({ ...base, exposureId: EXPOSURE_ID_B })).resolves.toEqual({
      status: "deduplicated",
    });
  });

  it("markSealed fails loud when the ticket binding is missing while exposure is live", async () => {
    const storage = {
      exposure: undefined as
        | { ticketFingerprint: string; delivery: "pending"; expiresAt: number }
        | undefined,
      getExposure: async () => storage.exposure,
      getTicket: async () => undefined,
      putExposure: async () => undefined,
      putTicket: async () => undefined,
      deleteExposure: async () => undefined,
      deleteTicket: async () => undefined,
      deleteExpired: async () => null,
      setExpiryAlarm: async () => undefined,
    };
    storage.exposure = {
      ticketFingerprint: "shared-fingerprint",
      delivery: "pending",
      expiresAt: NOW + 60_000,
    };
    await expect(
      applyExposureRedemptionMarkSealed(storage, {
        exposureId: EXPOSURE_ID_A,
        ticketFingerprint: "shared-fingerprint",
        nowMs: NOW,
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/ticket binding missing/),
    });
  });
});

describe("Durable claim response parsers (fail-loud)", () => {
  it("rejects invalid claim outcomes instead of defaulting to acquired", () => {
    expect(() => parseClaimOutcome({ status: "nope" })).toThrow(/invalid outcome/);
    expect(() => parseClaimOutcome({})).toThrow(/invalid outcome/);
    expect(() => parseClaimOutcome({ status: "nope" })).toThrow(ExposureRedemptionClaimFault);
  });

  it("rejects invalid acknowledge outcomes instead of defaulting to accepted", () => {
    expect(() => parseAcknowledgeOutcome({ status: "ok" })).toThrow(/invalid outcome/);
    expect(() => parseAcknowledgeOutcome({ ok: true })).toThrow(/invalid outcome/);
  });

  it("rejects non-ok markSealed/release bodies instead of treating them as success", () => {
    expect(() => parseOk({})).toThrow(/invalid ok/);
    expect(() => parseOk({ ok: false })).toThrow(/invalid ok/);
    expect(() => parseOk({ status: "acquired" })).toThrow(/invalid ok/);
  });
});
