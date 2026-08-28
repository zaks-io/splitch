import { eventDefinitionConfigKey } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import { ingestAdmissionScopeName } from "./ingest-admission-config";
import {
  hotConfig,
  METRIC_APP_ID,
  METRIC_CLIENT_KEY,
  METRIC_ENVIRONMENT_ID,
  METRIC_EVENT_NAME,
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";
import { handleAuthorizedMetricEvent } from "./metric-event-ingest";
import { TestExecutionContext } from "./test-fixtures";

describe("Metric Event ingest", () => {
  it("accepts the Evaluation-authorized caller only through the binding entrypoint", async () => {
    const fixture = await makeMetricEventFixture();

    const bound = await sendMetricEvent(fixture, metricEventBody());
    expect(bound.status).toBe(202);

    const publicResponse = await worker.fetch(
      new Request("https://ingest.test/api/sdk/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${METRIC_CLIENT_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(metricEventBody({ eventId: "123e4567-e89b-42d3-a456-426614174001" })),
      }) as Parameters<typeof worker.fetch>[0],
      fixture.env,
      new TestExecutionContext(),
    );
    expect(publicResponse.status).toBe(404);
  });

  it("accepts once, returns the original Version on retry, and rejects conflicting reuse", async () => {
    const fixture = await makeMetricEventFixture();
    const first = await sendMetricEvent(fixture, metricEventBody());
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });

    fixture.config.set(
      eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
      hotConfig("edv_2", 2),
    );
    const retry = await sendMetricEvent(fixture, metricEventBody());
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({
      accepted: true,
      duplicate: true,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });

    const conflict = await sendMetricEvent(
      fixture,
      metricEventBody({ fields: { converted: false } }),
    );
    expect(conflict.status).toBe(409);
    expect(await responseCode(conflict)).toBe("EVENT_ID_CONFLICT");
    expect(fixture.claims.size).toBe(1);
  });

  it("charges one new Metric Event under the scoped metric_events gate", async () => {
    const fixture = await makeMetricEventFixture();

    const response = await sendMetricEvent(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(fixture.claims.size).toBe(1);
    expect(fixture.admissionCharges).toEqual([
      {
        scope: ingestAdmissionScopeName(METRIC_APP_ID, METRIC_ENVIRONMENT_ID, "metric_events"),
        rowCost: 1,
        byteCost: expect.any(Number),
      },
    ]);
    expect(fixture.admissionCharges[0]?.byteCost).toBeGreaterThan(0);
  });

  it("rejects an exhausted gate before creating a claim", async () => {
    const fixture = await makeMetricEventFixture({}, "client_key", {
      admission: { allowed: false, retryAfterMs: 2500 },
    });

    const response = await sendMetricEvent(fixture, metricEventBody());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterMs: 2500 },
    });
    expect(fixture.claims.size).toBe(0);
    expect(fixture.admissionCharges).toHaveLength(1);
  });

  it.each([
    false,
    "throw",
  ] as const)("fails closed when the Admission Gate is %s", async (admission) => {
    const fixture = await makeMetricEventFixture({}, "client_key", { admission });

    const response = await sendMetricEvent(fixture, metricEventBody());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "Ingest Admission Gate is unavailable",
      details: { retryAfterMs: 1000 },
    });
    expect(fixture.claims.size).toBe(0);
  });

  it("does not charge an exact retry and returns the original Version", async () => {
    const fixture = await makeMetricEventFixture();
    const first = await sendMetricEvent(fixture, metricEventBody());
    expect(first.status).toBe(202);

    fixture.config.set(
      eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
      hotConfig("edv_2", 2),
    );
    const retry = await sendMetricEvent(fixture, metricEventBody());

    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({
      accepted: true,
      duplicate: true,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(fixture.claims.size).toBe(1);
    expect(fixture.admissionCharges).toHaveLength(1);
  });

  it("rejects unknown fields before creating a durable claim", async () => {
    const fixture = await makeMetricEventFixture();
    const response = await sendMetricEvent(
      fixture,
      metricEventBody({ fields: { converted: true, profile: "forbidden" } }),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["fields", "profile"], message: "fields key is not declared" }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("edv_1");
    expect(fixture.claims.size).toBe(0);
    expect(fixture.admissionCharges).toHaveLength(0);
  });
});

describe("Metric Event ingest request bounds", () => {
  it("rejects an oversized body from Content-Length before reading its stream", async () => {
    const fixture = await makeMetricEventFixture();
    const request = new Request("https://ingest.test/metric-events", {
      method: "POST",
      headers: { "content-length": "32769" },
      body: "{}",
    });
    const getReader = vi.spyOn(request.body as ReadableStream<Uint8Array>, "getReader");

    const response = await handleAuthorizedMetricEvent(request, fixture.env, {
      credentialHash: fixture.hash,
      credentialKind: fixture.credentialKind,
      appId: METRIC_APP_ID,
      environmentId: "env_prod",
      rateLimitRps: null,
    });

    expect(response.status).toBe(400);
    expect(getReader).not.toHaveBeenCalled();
  });
});

describe("Metric Event ingest admission", () => {
  it("rejects a malformed allow decision before creating a claim", async () => {
    const fixture = await makeMetricEventFixture({}, "client_key", {
      admission: { allowed: true, retryAfterMs: -1 },
    });

    const response = await sendMetricEvent(fixture, metricEventBody());

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "Ingest Admission Gate is unavailable",
    });
    expect(fixture.claims.size).toBe(0);
    expect(fixture.admissionCharges).toHaveLength(1);
  });
});

async function responseCode(response: Response): Promise<unknown> {
  return ((await response.json()) as { code?: unknown }).code;
}
