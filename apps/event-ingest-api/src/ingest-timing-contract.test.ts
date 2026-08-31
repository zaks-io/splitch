import { afterEach, describe, expect, it, vi } from "vitest";
import { queuePayloadBytes } from "./ingest-admission-gate";
import {
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";
import {
  deliverRawEventMessages,
  rawEventMessage,
  rawEventPrivacyNamespace,
} from "./raw-event-queue-test-fixture";
import { expectRow, fixedNow, makeEnv, postEvaluationAt, postExposure } from "./test-fixtures";

const privacySalt = "test-root-secret-do-not-use";

function productionEnv() {
  return {
    ...makeEnv(),
    SPLITCH_PLATFORM_TARGET: "production",
    EVALUATION_PRIVACY_SALT: privacySalt,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ingest timing contract", () => {
  it("emits the stable scrubbed Exposure timing shape", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const calls = await postExposure({
      env: productionEnv(),
    });

    const event = timingEvent(info.mock.calls, "internal_exposure");
    expect(event).toEqual(
      expect.objectContaining({
        stream: "raw_events",
        outcome: "accepted",
        itemCount: 1,
        totalMs: expect.any(Number),
        authMs: expect.any(Number),
        serializedBytes: queuePayloadBytes(expectRow(calls.rows)),
      }),
    );
    expect(JSON.stringify(event)).not.toContain("user@example.com");
  });

  it("emits the stable scrubbed Evaluation usage timing shape", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const calls = await postEvaluationAt(fixedNow, {}, undefined, productionEnv());

    expect(timingEvent(info.mock.calls, "internal_evaluation_usage")).toEqual(
      expect.objectContaining({
        stream: "raw_evaluations",
        outcome: "accepted",
        itemCount: 1,
        totalMs: expect.any(Number),
        rowMs: expect.any(Number),
        serializedBytes: queuePayloadBytes(expectRow(calls.rows)),
      }),
    );
  });

  it("emits the stable scrubbed Metric Event timing shape", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fixture = await makeMetricEventFixture({
      SPLITCH_PLATFORM_TARGET: "production",
      EVALUATION_PRIVACY_SALT: privacySalt,
      ENTITY_METRIC_PRIVACY: makeEnv().ENTITY_METRIC_PRIVACY,
    });
    const body = metricEventBody();

    const response = await sendMetricEvent(fixture, body);

    expect(response.status).toBe(202);
    expect(timingEvent(info.mock.calls, "sdk_metric_event")).toEqual(
      expect.objectContaining({
        stream: "metric_events",
        outcome: "accepted",
        itemCount: 1,
        totalMs: expect.any(Number),
        parseMs: expect.any(Number),
        serializedBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
      }),
    );
  });

  it("emits raw queue settlement through the same scrubbed timing shape", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ successful_rows: 1, quarantined_rows: 0 })),
    );
    const queued = rawEventMessage("timing-contract", "raw_evaluations");
    const privacy = rawEventPrivacyNamespace();

    await deliverRawEventMessages("splitch-raw-evaluations", [queued], {
      SPLITCH_PLATFORM_TARGET: "production",
      ENTITY_METRIC_PRIVACY: privacy.namespace,
    });

    const event = timingEvent(info.mock.calls, "raw_queue_settlement");
    expect(event).toEqual(
      expect.objectContaining({
        stream: "raw_evaluations",
        outcome: "accepted",
        itemCount: 1,
        totalMs: expect.any(Number),
        admissionMs: expect.any(Number),
        deliveryMs: expect.any(Number),
        serializedBytes: queuePayloadBytes(queued.body),
        deliveredCount: 1,
      }),
    );
    expect(JSON.stringify(event)).not.toContain("app_id");
    expect(JSON.stringify(event)).not.toContain("sha256:timing-contract");
  });
});

function timingEvent(
  calls: readonly (readonly unknown[])[],
  route: string,
): Record<string, unknown> {
  const event = calls
    .map(([candidate]) => candidate)
    .find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "message" in candidate &&
        candidate.message === "ingest_phase_timing" &&
        "route" in candidate &&
        candidate.route === route,
    );
  expect(event, `missing timing event for ${route}`).toBeDefined();
  return event as Record<string, unknown>;
}
