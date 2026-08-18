import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  MemoryExposureRedemptionClaimStore,
} from "./exposure-redemption-claim";
import type { ExposureRedemptionClaimStore } from "./exposure-redemption-claim-core";
import { ExposureRedemptionClaimProtocolError } from "./exposure-redemption-claim-errors";
import { fakeNamespaceByPath, jsonOk, redeemWithStore } from "./exposures-claim-fault-fixtures";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import { CLIENT_KEY, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

describe("POST /api/sdk/exposures: confirm/ack claim-store seam (SPL-366)", () => {
  it("maps acknowledge protocol violation to INTERNAL_SERVER_ERROR (not retryable)", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespaceByPath({
        "/claim": async () => jsonOk({ status: "acquired" }),
        "/markSealed": async () => jsonOk({ ok: true }),
        "/acknowledge": async () => jsonOk({ status: "nope" }),
      }),
    );
    const { body, exposureSink } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
  });

  it("maps acknowledge HTTP 409 to INTERNAL_SERVER_ERROR", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespaceByPath({
        "/claim": async () => jsonOk({ status: "acquired" }),
        "/markSealed": async () => jsonOk({ ok: true }),
        "/acknowledge": async () =>
          new Response(JSON.stringify({ error: "mismatch" }), { status: 409 }),
      }),
    );
    const { body, exposureSink } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
  });

  it("maps markSealed HTTP 409 to INTERNAL_SERVER_ERROR", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespaceByPath({
        "/claim": async () => jsonOk({ status: "acquired" }),
        "/markSealed": async () =>
          new Response(JSON.stringify({ error: "mismatch" }), { status: 409 }),
        "/acknowledge": async () => jsonOk({ status: "accepted" }),
      }),
    );
    const { body, exposureSink } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
  });

  it("drains after five retries when acknowledge keeps returning a protocol violation", async () => {
    const memory = new MemoryExposureRedemptionClaimStore();
    const store: ExposureRedemptionClaimStore = {
      claim: (input) => memory.claim(input),
      release: (input) => memory.release(input),
      markSealed: (input) => memory.markSealed(input),
      acknowledge: async () => {
        throw new ExposureRedemptionClaimProtocolError(
          "exposure redemption acknowledge returned an invalid outcome",
        );
      },
    };
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: store,
    });
    const ticket = await mintTicket();
    const init = exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]);

    const codes: Array<string | null | undefined> = [];
    for (let i = 0; i < 5; i++) {
      const body = (await (await app.request(PATH, init)).json()) as ExposureBatchResponse;
      codes.push(body.results[0]?.code);
    }

    expect(codes).toEqual([
      "INTERNAL_SERVER_ERROR",
      "INTERNAL_SERVER_ERROR",
      "INTERNAL_SERVER_ERROR",
      "INTERNAL_SERVER_ERROR",
      "INTERNAL_SERVER_ERROR",
    ]);
    expect(exposureSink.writes).toHaveLength(1);
  });
});
