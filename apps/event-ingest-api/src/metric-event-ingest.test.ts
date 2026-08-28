import { eventDefinitionConfigKey } from "@splitch/contracts";
import {
  computeTargetingKeyHash,
  makeMemoryIdentityKeyPersist,
  makePersistedIdentitySaltStore,
  mintAppIdentityEpoch,
} from "@splitch/privacy";
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
import { fingerprintMetricEvent, sha256Prefixed } from "./metric-event-admission";
import { handleAuthorizedMetricEvent, makeMetricEventSaltStore } from "./metric-event-ingest";
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
    expect(await first.json()).toMatchObject({
      duplicate: false,
      eventDefinitionVersionId: "edv_1",
    });

    fixture.config.set(
      eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
      hotConfig("edv_2", 2),
    );
    const retry = await sendMetricEvent(fixture, metricEventBody());
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      duplicate: true,
      eventDefinitionVersionId: "edv_1",
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
    expect(await retry.json()).toMatchObject({
      duplicate: true,
      eventDefinitionVersionId: "edv_1",
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
    expect(response.status).toBe(400);
    expect(await responseCode(response)).toBe("EVENT_SCHEMA_MISMATCH");
    expect(fixture.claims.size).toBe(0);
    expect(fixture.admissionCharges).toHaveLength(0);
  });

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
      appId: METRIC_APP_ID,
      environmentId: "env_prod",
      rateLimitRps: null,
    });

    expect(response.status).toBe(400);
    expect(getReader).not.toHaveBeenCalled();
  });
});

describe("Metric Event identity retries", () => {
  it("accepts an exact retry whose claim used a leftover app-v1 Targeting Key hash", async () => {
    const fixture = await makeMetricEventFixture();
    const body = metricEventBody();
    const leftoverHash = await computeTargetingKeyHash(makeMetricEventSaltStore(fixture.env), {
      appId: METRIC_APP_ID,
      idType: String(body.idType),
      targetingKey: String(body.targetingKey),
      keyVersion: "app-v1",
    });
    const fingerprint = await fingerprintMetricEvent({
      eventName: String(body.eventName),
      idType: String(body.idType),
      targetingKeyHash: leftoverHash,
      fields: body.fields,
      dimensions: body.dimensions,
    });
    fixture.claims.set(
      await sha256Prefixed(
        `metric:${METRIC_APP_ID}:${METRIC_ENVIRONMENT_ID}:${String(body.eventId)}`,
      ),
      {
        fingerprint,
        eventDefinitionId: "edv_1",
        eventDefinitionVersionId: "edv_1",
      },
    );

    const retry = await sendMetricEvent(fixture, body);

    expect(leftoverHash.startsWith("app-v1:")).toBe(true);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      duplicate: true,
      eventDefinitionVersionId: "edv_1",
    });
    expect(fixture.claims.size).toBe(1);
    expect(fixture.admissionCharges).toHaveLength(0);
  });
});

describe("Metric Event privacy salts", () => {
  it("bootstraps retained v1 hashes and keeps leftover app-v1 resolvable", async () => {
    const store = makeMetricEventSaltStore({
      EVALUATION_PRIVACY_SALT: "test-root-secret-do-not-use",
      SPLITCH_PLATFORM_TARGET: "production",
    } as never);
    const input = { idType: "user", targetingKey: "user-123" } as const;
    const current = await computeTargetingKeyHash(store, { ...input, appId: "app_1" });
    const otherApp = await computeTargetingKeyHash(store, { ...input, appId: "app_2" });
    const leftover = await computeTargetingKeyHash(store, {
      ...input,
      appId: "app_1",
      keyVersion: "app-v1",
    });
    expect(current).toBe("v1:485bdba84f840c9627db32bcc99a6f00722b5253754e513ff473c90a8febc588");
    expect(otherApp).toBe(current);
    expect(leftover).toBe(
      "app-v1:45f18403be72b778d418f62c9a0283fc4ab44bee3bc6fba1a5927543e021c01a",
    );
    expect(leftover).not.toBe(current);
  });

  it("isolates two Apps after minting independent identity keys under one KEK", async () => {
    const persist = makeMemoryIdentityKeyPersist();
    const rootSecret = "test-root-secret-do-not-use";
    await mintAppIdentityEpoch({
      persist,
      appId: "app_1",
      kekMaterial: rootSecret,
      epochId: "epoch-a",
    });
    await mintAppIdentityEpoch({
      persist,
      appId: "app_2",
      kekMaterial: rootSecret,
      epochId: "epoch-b",
    });
    const store = makePersistedIdentitySaltStore({
      persist,
      rootSecret,
      currentKeyVersion: "v1",
    });
    const input = { idType: "user", targetingKey: "user-123" } as const;
    const appA = await computeTargetingKeyHash(store, { ...input, appId: "app_1" });
    const appB = await computeTargetingKeyHash(store, { ...input, appId: "app_2" });
    expect(appA).not.toBe(appB);
    expect(appA.startsWith("epoch-a:")).toBe(true);
    expect(appB.startsWith("epoch-b:")).toBe(true);
  });

  it("rejects a missing hosted root salt or platform target", () => {
    expect(() => makeMetricEventSaltStore({} as never)).toThrow(/SPLITCH_PLATFORM_TARGET/);
    expect(() =>
      makeMetricEventSaltStore({ SPLITCH_PLATFORM_TARGET: "production" } as never),
    ).toThrow(/EVALUATION_PRIVACY_SALT/);
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
