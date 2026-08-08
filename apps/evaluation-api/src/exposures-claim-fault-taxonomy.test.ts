import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  MemoryExposureRedemptionClaimStore,
  type ExposureRedemptionClaimNamespace,
} from "./exposure-redemption-claim";
import type {
  ExposureRedemptionClaimInput,
  ExposureRedemptionClaimOutcome,
  ExposureRedemptionClaimStore,
} from "./exposure-redemption-claim-core";
import { ExposureRedemptionClaimProtocolError } from "./exposure-redemption-claim-errors";
import {
  EXPOSURE_ID_A,
  EXPOSURE_ID_B,
  EXPOSURE_ID_C,
  exposuresInit,
  mintTicket,
  PATH,
} from "./exposures-test-fixtures";
import { APP_ID, CLIENT_KEY, ENVIRONMENT_ID, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

const REQUEST_ID = "req_spl_366_claim_taxonomy";
const INNER_CAUSE = "Network connection lost: durable object 7f3a stub reset";
const BODY_READ_LOST = "Network connection lost";

function fakeNamespace(fetchImpl: () => Promise<Response>): ExposureRedemptionClaimNamespace {
  return {
    idFromName: (name) => ({ toString: () => name }) as DurableObjectId,
    get: () => ({ fetch: async () => fetchImpl() }),
  };
}

/** Path-aware DO stub — claim / markSealed / acknowledge can diverge. */
function fakeNamespaceByPath(
  handlers: Readonly<Record<string, () => Promise<Response>>>,
): ExposureRedemptionClaimNamespace {
  return {
    idFromName: (name) => ({ toString: () => name }) as DurableObjectId,
    get: () => ({
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        const handler = handlers[path];
        if (!handler) throw new Error(`unexpected DO path ${path}`);
        return handler();
      },
    }),
  };
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function redeemWithStore(store: ExposureRedemptionClaimStore): Promise<{
  status: number;
  body: ExposureBatchResponse;
  exposureSink: Awaited<ReturnType<typeof makeSdkRouteHarness>>["exposureSink"];
  logger: Awaited<ReturnType<typeof makeSdkRouteHarness>>["logger"];
}> {
  const { app, exposureSink, logger } = await makeSdkRouteHarness({
    liveRun: true,
    exposureRedemptionClaims: store,
  });
  const ticket = await mintTicket();
  const response = await app.request(
    PATH,
    exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }], {
      "x-request-id": REQUEST_ID,
    }),
  );
  const body = (await response.json()) as ExposureBatchResponse;
  return { status: response.status, body, exposureSink, logger };
}

describe("POST /api/sdk/exposures: real-store claim faults (SPL-366)", () => {
  it("maps parseClaimOutcome protocol violation through DurableExposureRedemptionClaimStore", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(async () => jsonOk({ status: "nope" })),
    );
    const { body, exposureSink, logger } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim returned an invalid outcome"],
    });
  });

  it("maps Durable Object HTTP 400 through DurableExposureRedemptionClaimStore", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(async () => new Response("bad request", { status: 400 })),
    );
    const { body, exposureSink, logger } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim Durable Object returned HTTP 400"],
    });
  });

  it("maps Durable Object HTTP 404 on claim to INTERNAL_SERVER_ERROR", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(
        async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      ),
    );
    const { body } = await redeemWithStore(store);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
  });

  it("maps Durable Object transport throw through DurableExposureRedemptionClaimStore", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(async () => {
        throw new Error(INNER_CAUSE);
      }),
    );
    const { body, exposureSink, logger } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors).toEqual([
      {
        message: "exposure_redemption_claim_failed",
        detail: {
          requestId: REQUEST_ID,
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          causeChain: ["exposure redemption claim Durable Object transport failed", INNER_CAUSE],
        },
      },
    ]);
  });

  it("maps body-read failure after HTTP 200 to retryable SERVICE_UNAVAILABLE", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(async () => {
        const response = jsonOk({ status: "acquired" });
        response.json = async () => {
          throw new TypeError(BODY_READ_LOST);
        };
        return response;
      }),
    );
    const { body, exposureSink, logger } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors[0]?.detail).toMatchObject({
      causeChain: ["exposure redemption claim Durable Object transport failed", BODY_READ_LOST],
    });
  });

  it("maps Durable Object HTTP 500 to retryable SERVICE_UNAVAILABLE", async () => {
    const store = new DurableExposureRedemptionClaimStore(
      fakeNamespace(async () => jsonOk({ status: "acquired" }, 500)),
    );
    const { body } = await redeemWithStore(store);

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
  });
});

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
    // Ingest already committed — taxonomy must still drop so the SDK does not loop.
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
    // Real Memory claim state + typed protocol throw on every acknowledge — the
    // pre-fix path returned SERVICE_UNAVAILABLE five times with sinkWrites=1.
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

describe("POST /api/sdk/exposures: programming + sibling claim faults (SPL-366)", () => {
  it("maps TypeError from claim() to non-retryable INTERNAL_SERVER_ERROR", async () => {
    const claims: ExposureRedemptionClaimStore = {
      claim: async () => {
        throw new TypeError("undefined is not a function");
      },
      release: async () => undefined,
      markSealed: async () => undefined,
      acknowledge: async () => ({ status: "accepted" }),
    };
    const { status, body, exposureSink, logger } = await redeemWithStore(claims);

    expect(status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
    ]);
    expect(exposureSink.writes).toHaveLength(0);
    expect(logger.errors).toEqual([
      {
        message: "exposure_redemption_claim_failed",
        detail: {
          requestId: REQUEST_ID,
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          causeChain: ["undefined is not a function"],
        },
      },
    ]);
  });

  it("leaves siblings ordered and accepted around a deterministic middle fault", async () => {
    const memory = new MemoryExposureRedemptionClaimStore();
    const claims: ExposureRedemptionClaimStore = {
      async claim(input: ExposureRedemptionClaimInput): Promise<ExposureRedemptionClaimOutcome> {
        if (input.exposureId === EXPOSURE_ID_B) {
          throw new TypeError("undefined is not a function");
        }
        return memory.claim(input);
      },
      release: (input) => memory.release(input),
      markSealed: (input) => memory.markSealed(input),
      acknowledge: (input) => memory.acknowledge(input),
    };
    const { app, exposureSink, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      exposureRedemptionClaims: claims,
    });
    const [ticketA, ticketB, ticketC] = await Promise.all([
      mintTicket({ targetingKey: "entity-a" }),
      mintTicket({ targetingKey: "entity-b" }),
      mintTicket({ targetingKey: "entity-c" }),
    ]);

    const body = (await (
      await app.request(
        PATH,
        exposuresInit(CLIENT_KEY, [
          { exposureId: EXPOSURE_ID_A, exposureTicket: ticketA },
          { exposureId: EXPOSURE_ID_B, exposureTicket: ticketB },
          { exposureId: EXPOSURE_ID_C, exposureTicket: ticketC },
        ]),
      )
    ).json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
      { exposureId: EXPOSURE_ID_B, status: "rejected", code: "INTERNAL_SERVER_ERROR" },
      { exposureId: EXPOSURE_ID_C, status: "accepted", code: null },
    ]);
    expect(exposureSink.writes.map(({ eventId }) => eventId)).toEqual([
      EXPOSURE_ID_A,
      EXPOSURE_ID_C,
    ]);
    expect(assignmentStore.putHashedCalls).toHaveLength(2);
  });
});
