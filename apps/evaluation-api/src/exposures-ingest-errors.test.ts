import type { ExposureBatchResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { ExposureIngestSinkError, RecordingExposureIngestSink } from "./exposure-redemption";
import { EXPOSURE_ID_A, exposuresInit, mintTicket, PATH } from "./exposures-test-fixtures";
import { CLIENT_KEY, makeSdkRouteHarness } from "./sdk-route-test-fixtures";

describe("POST /api/sdk/exposures: ingest failure mapping", () => {
  it("returns per-item SERVICE_UNAVAILABLE when the ingest seam fails with 503", async () => {
    const failing = new RecordingExposureIngestSink();
    failing.write = async () => {
      throw new ExposureIngestSinkError("ingest down", { status: 503 });
    };
    const { app, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      exposureIngestSink: failing,
    });
    const ticket = await mintTicket();

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });

  it("maps ingest 400 to a non-retryable VALIDATION_ERROR", async () => {
    const failing = new RecordingExposureIngestSink();
    failing.write = async () => {
      throw new ExposureIngestSinkError("idType mismatch", { status: 400 });
    };
    const { app, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      exposureIngestSink: failing,
    });
    const ticket = await mintTicket();

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "VALIDATION_ERROR" },
    ]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });

  it("maps ingest 401 (token drift) to retryable SERVICE_UNAVAILABLE", async () => {
    const failing = new RecordingExposureIngestSink();
    failing.write = async () => {
      throw new ExposureIngestSinkError("invalid internal ingest token", { status: 401 });
    };
    const { app, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      exposureIngestSink: failing,
    });
    const ticket = await mintTicket();

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(res.status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });

  it("maps ingest 404 (config propagation lag) to retryable SERVICE_UNAVAILABLE", async () => {
    const failing = new RecordingExposureIngestSink();
    failing.write = async () => {
      throw new ExposureIngestSinkError("Experiment config not found", { status: 404 });
    };
    const { app, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
      exposureIngestSink: failing,
    });
    const ticket = await mintTicket();

    const res = await app.request(
      PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: ticket }]),
    );
    const body = (await res.json()) as ExposureBatchResponse;

    expect(res.status).toBe(202);
    expect(body.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "rejected", code: "SERVICE_UNAVAILABLE" },
    ]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
  });
});
