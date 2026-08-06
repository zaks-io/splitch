import {
  CredentialCacheKVSchema,
  clientKeyCacheKey,
  type ExposureBatchResponse,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption";
import {
  APP_B,
  CLIENT_KEY_B,
  ENV_B,
  EXPOSURE_ID_A,
  EXPOSURE_ID_B,
  exposuresInit,
  mintTicket,
  PATH,
  PREVIOUS_TICKET_KEY,
} from "./exposures-test-fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  makeSdkRouteHarness,
  sha256Hex,
} from "./sdk-route-test-fixtures";

describe("POST /api/sdk/exposures: forgery and integrity", () => {
  it("rejects a forged ticket whose MAC does not verify", async () => {
    const { app, exposureSink, assignmentStore } = await makeSdkRouteHarness({ liveRun: true });
    const ticket = await mintTicket();
    const [payload] = ticket.split(".");
    const forged = `${payload}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: forged }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(res.status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "EXPOSURE_TICKET_INVALID" },
    ]);
    expect(exposureSink.writes).toEqual([]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });

  it("rejects a ticket whose payload fields were tampered after minting", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({ liveRun: true });
    const ticket = await mintTicket({ variant: "treatment" });
    const [, signature] = ticket.split(".");
    const tamperedPayload = {
      app_id: APP_ID,
      environment_id: ENVIRONMENT_ID,
      experiment_id: EXPERIMENT_ID,
      run_id: "run-42",
      flag_key: FLAG_KEY,
      variant: "control",
      id_type: "user",
      targeting_key_hash: "v1:forged",
      issued_at: "2026-07-03T00:00:00.000Z",
    };
    const encoded = btoa(JSON.stringify(tamperedPayload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tampered = `${encoded}.${signature}`;

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: tampered }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(body.results[0]?.code).toBe("EXPOSURE_TICKET_INVALID");
    expect(exposureSink.writes).toEqual([]);
  });

  it("rejects an expired ticket loudly", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      ticketNow: () => new Date("2026-07-05T00:00:00.000Z"),
    });
    const expired = await mintTicket({ issuedAt: "2026-07-03T00:00:00.000Z" });

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: expired }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "EXPOSURE_TICKET_EXPIRED" },
    ]);
    expect(exposureSink.writes).toEqual([]);
  });

  it("accepts a ticket signed with the previous rotation key", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      previousTicketKey: PREVIOUS_TICKET_KEY,
    });
    const ticket = await mintTicket({ ticketKey: PREVIOUS_TICKET_KEY });

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(body.results[0]?.status).toBe("accepted");
    expect(exposureSink.writes).toHaveLength(1);
  });

  it("rejects reusing an exposureId with a different ticket as EVENT_ID_CONFLICT", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const firstTicket = await mintTicket({ targetingKey: "user-1" });
    const secondTicket = await mintTicket({ targetingKey: "user-2" });

    await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: firstTicket }]),
    );
    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: secondTicket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "EVENT_ID_CONFLICT" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
  });

  it("deduplicates the same ticket redeemed under a fresh exposureId (no amplification)", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const { app, exposureSink, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const ticket = await mintTicket();

    const first = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const second = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_B, exposureTicket: ticket }]),
    );
    const secondBody = (await second.json()) as ExposureBatchResponse;

    expect(first.status).toBe(202);
    expect(secondBody.results).toEqual([
      { exposureId: EXPOSURE_ID_B, status: "deduplicated", code: null },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
    expect(assignmentStore.putHashedCalls).toHaveLength(1);
  });
});

describe("POST /api/sdk/exposures: cross-tenant", () => {
  it("rejects App B credentials redeeming an App A ticket", async () => {
    const { app, credentialKv, exposureSink, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
    });
    credentialKv.put(
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY_B)),
      CredentialCacheKVSchema.parse({
        appId: APP_B,
        environmentId: ENV_B,
        credentialSchemaVersion: 2,
        organizationId: "org_b",
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: false,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    const ticket = await mintTicket({ appId: APP_ID });

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY_B, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "EXPOSURE_TICKET_INVALID" },
    ]);
    expect(exposureSink.writes).toEqual([]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });

  it("rejects a same-App credential scoped to a different Environment", async () => {
    const { app, credentialKv, exposureSink, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
    });
    const stagingKey = "pk_exposures_staging";
    credentialKv.put(
      clientKeyCacheKey(await sha256Hex(stagingKey)),
      CredentialCacheKVSchema.parse({
        appId: APP_ID,
        environmentId: ENV_B,
        credentialSchemaVersion: 2,
        organizationId: "org_verify",
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: false,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    const ticket = await mintTicket({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
    });

    const res = await app.request(
      PATH,
      exposuresInit(stagingKey, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "EXPOSURE_TICKET_INVALID" },
    ]);
    expect(exposureSink.writes).toEqual([]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });

  it("isolates claim stores so two Apps may redeem the same exposureId", async () => {
    const claims = new MemoryExposureRedemptionClaimStore();
    const { app, credentialKv, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    credentialKv.put(
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY_B)),
      CredentialCacheKVSchema.parse({
        appId: APP_B,
        environmentId: ENV_B,
        credentialSchemaVersion: 2,
        organizationId: "org_b",
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: false,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    const ticketA = await mintTicket({ appId: APP_ID, environmentId: ENVIRONMENT_ID });
    const ticketB = await mintTicket({ appId: APP_B, environmentId: ENV_B });

    const first = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticketA }]),
    );
    const second = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY_B, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticketB }]),
    );
    const firstBody = (await first.json()) as ExposureBatchResponse;
    const secondBody = (await second.json()) as ExposureBatchResponse;

    expect(firstBody.results[0]?.status).toBe("accepted");
    expect(secondBody.results[0]?.status).toBe("accepted");
    expect(exposureSink.writes).toHaveLength(2);
    expect(exposureSink.writes.map((row) => row.appId).sort()).toEqual([APP_B, APP_ID].sort());
  });
});
