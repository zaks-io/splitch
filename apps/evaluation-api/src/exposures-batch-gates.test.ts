import {
  type ErrorResponse,
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  EXPOSURE_BATCH_MAX_ITEMS,
  type ExposureBatchResponse,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  EXPOSURE_ID_A,
  EXPOSURE_ID_B,
  exposuresInit,
  mintTicket,
  PATH,
} from "./exposures-test-fixtures";
import { CLIENT_KEY, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

describe("POST /api/sdk/exposures: batch gates fail loud", () => {
  it("rejects an oversize item count as a whole-request VALIDATION_ERROR", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({ liveRun: true });
    const ticket = await mintTicket();
    const exposures = Array.from({ length: EXPOSURE_BATCH_MAX_ITEMS + 1 }, (_, i) => ({
      exposureId: `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, "0")}`,
      exposureTicket: ticket,
    }));

    const res = await app.request(PATH, exposuresInit(CLIENT_KEY, exposures));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(exposureSink.writes).toEqual([]);
  });

  it("rejects a UTF-8 body over 32 KiB as a whole-request VALIDATION_ERROR", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({ liveRun: true });
    // Pad exposureTicket so the serialized body exceeds the byte cap while staying
    // ≤25 items and keeping clientTimestamp a valid ISO datetime.
    const padding = "x".repeat(EXPOSURE_BATCH_MAX_BODY_BYTES);
    const res = await app.request(PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        exposures: [
          {
            exposureId: EXPOSURE_ID_A,
            exposureTicket: `ticket.${padding}`,
            clientTimestamp: "2026-07-03T00:00:01.000Z",
          },
        ],
      }),
    });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body)).toContain(String(EXPOSURE_BATCH_MAX_BODY_BYTES));
    expect(exposureSink.writes).toEqual([]);
  });

  it("rejects a non-datetime clientTimestamp as a whole-request VALIDATION_ERROR", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({ liveRun: true });
    const ticket = await mintTicket();

    const res = await app.request(PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        exposures: [
          {
            exposureId: EXPOSURE_ID_A,
            exposureTicket: ticket,
            clientTimestamp: "not-a-timestamp",
          },
        ],
      }),
    });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(exposureSink.writes).toEqual([]);
  });

  it("rejects malformed records loudly without partial silent acceptance", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({ liveRun: true });
    const ticket = await mintTicket();

    const res = await app.request(PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        exposures: [
          {
            exposureId: "not-a-uuid",
            exposureTicket: ticket,
            clientTimestamp: "2026-07-03T00:00:01.000Z",
          },
        ],
      }),
    });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(exposureSink.writes).toEqual([]);
  });

  it("keeps valid siblings accepted when one item is rejected", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({ liveRun: true });
    const good = await mintTicket();
    const bad = "not.a.valid.ticket";

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [
        { exposureId: EXPOSURE_ID_A, exposureTicket: good },
        { exposureId: EXPOSURE_ID_B, exposureTicket: bad },
      ]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(res.status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
      { exposureId: EXPOSURE_ID_B, status: "rejected", code: "EXPOSURE_TICKET_INVALID" },
    ]);
    expect(exposureSink.writes).toHaveLength(1);
    expect(exposureSink.writes[0]?.eventId).toBe(EXPOSURE_ID_A);
  });
});
