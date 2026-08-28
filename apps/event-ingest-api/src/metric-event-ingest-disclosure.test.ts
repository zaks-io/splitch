import { eventDefinitionConfigKey } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  hotConfig,
  METRIC_APP_ID,
  METRIC_EVENT_NAME,
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";

describe("Metric Event ingest Client Key disclosure", () => {
  it("omits configured Entity type and Event Definition IDs from an idType mismatch", async () => {
    const fixture = await makeMetricEventFixture();
    const response = await sendMetricEvent(fixture, metricEventBody({ idType: "workspace" }));
    const body = await response.json();
    const raw = JSON.stringify(body);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      code: "ENTITY_TYPE_MISMATCH",
      message: "Metric Event Entity type does not match the Event Definition Version",
      details: { receivedIdType: "workspace" },
    });
    expect(raw).not.toContain("expectedIdType");
    expect(raw).not.toContain("ed_signed_up");
    expect(raw).not.toContain('"user"');
  });

  it("omits configured numeric bounds from a schema mismatch", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
      hotConfig("edv_1", 1, boundedAmountVersion()),
    );
    const response = await sendMetricEvent(
      fixture,
      metricEventBody({ fields: { amount: 5 }, dimensions: {} }),
    );
    const body = await response.json();
    const raw = JSON.stringify(body);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["fields", "amount"], message: "number is out of range" }],
      },
    });
    expect(raw).not.toContain("edv_1");
    expect(raw).not.toContain("at least");
    expect(raw).not.toContain("10");
    expect(raw).not.toContain("100");
  });

  it("omits configured allowlist values from a schema mismatch", async () => {
    const fixture = await makeMetricEventFixture();
    const response = await sendMetricEvent(
      fixture,
      metricEventBody({ dimensions: { plan: "enterprise" } }),
    );
    const body = await response.json();
    const raw = JSON.stringify(body);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["dimensions", "plan"], message: "value is not allowed" }],
      },
    });
    expect(raw).not.toContain("edv_1");
    expect(raw).not.toContain("pro");
    expect(raw).not.toContain("free");
  });
});

describe("Metric Event ingest Client Key probes", () => {
  it("omits configured field names and expected types from missing-required and wrong-type probes", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
      hotConfig("edv_1", 1, purchaseLimitVersion()),
    );
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });

    const missing = await sendMetricEvent(fixture, metricEventBody({ fields: {}, dimensions: {} }));
    const missingBody = await missing.json();
    const nested = await sendMetricEvent(
      fixture,
      metricEventBody({
        fields: { internal_purchase_limit: true, profile: {} },
        dimensions: {},
      }),
    );
    const nestedBody = await nested.json();
    const wrongType = await sendMetricEvent(
      fixture,
      metricEventBody({
        fields: { internal_purchase_limit: "not-a-bool", profile: { internal_quota: true } },
        dimensions: {},
      }),
    );
    const wrongTypeBody = await wrongType.json();
    error.mockRestore();

    expect(missing.status).toBe(400);
    expect(missingBody).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["fields"], message: "invalid value" }],
      },
    });
    expect(nestedBody).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["fields", "profile"], message: "invalid value" }],
      },
    });
    expect(wrongTypeBody).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["fields", "internal_purchase_limit"], message: "invalid value" }],
      },
    });
    for (const body of [missingBody, nestedBody]) {
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("internal_purchase_limit");
      expect(raw).not.toContain("internal_quota");
      expect(raw).not.toContain("required value is missing");
      expect(raw).not.toContain("expected boolean");
    }
    expect(JSON.stringify(wrongTypeBody)).not.toContain("expected boolean");
    const recorded = JSON.stringify(errors);
    expect(recorded).toContain("internal_purchase_limit");
    expect(recorded).toContain("internal_quota");
    expect(recorded).toContain("expected boolean");
    expect(recorded).toContain("required value is missing");
    expect(recorded).not.toMatch(/\.\.\./);
  });

  it("omits Event Definition IDs from Client Key first accept and replay", async () => {
    const fixture = await makeMetricEventFixture();
    const first = await sendMetricEvent(fixture, metricEventBody());
    const firstBody = await first.json();
    const replay = await sendMetricEvent(fixture, metricEventBody());
    const replayBody = await replay.json();

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(firstBody).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(replayBody).toEqual({
      accepted: true,
      duplicate: true,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(JSON.stringify(firstBody)).not.toContain("ed_signed_up");
    expect(JSON.stringify(firstBody)).not.toContain("edv_1");
    expect(JSON.stringify(replayBody)).not.toContain("ed_signed_up");
    expect(JSON.stringify(replayBody)).not.toContain("edv_1");
  });
});

describe("Metric Event ingest API Key disclosure", () => {
  it("keeps Event Definition diagnostics on the API Key path", async () => {
    const fixture = await makeMetricEventFixture({}, "api_key");
    fixture.config.set(
      eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
      hotConfig("edv_1", 1, boundedAmountVersion()),
    );

    const entity = await sendMetricEvent(fixture, metricEventBody({ idType: "workspace" }));
    expect(await entity.json()).toMatchObject({
      code: "ENTITY_TYPE_MISMATCH",
      details: {
        expectedIdType: "user",
        receivedIdType: "workspace",
        eventDefinitionId: "ed_signed_up",
      },
    });

    const bounds = await sendMetricEvent(
      fixture,
      metricEventBody({ fields: { amount: 5 }, dimensions: {} }),
    );
    expect(await bounds.json()).toMatchObject({
      code: "EVENT_SCHEMA_MISMATCH",
      details: {
        eventName: METRIC_EVENT_NAME,
        eventDefinitionVersionId: "edv_1",
        issues: [{ path: ["fields", "amount"], message: "number must be at least 10" }],
      },
    });

    const accepted = await sendMetricEvent(
      fixture,
      metricEventBody({
        eventId: "123e4567-e89b-42d3-a456-426614174099",
        fields: { amount: 20 },
        dimensions: {},
      }),
    );
    expect(await accepted.json()).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "123e4567-e89b-42d3-a456-426614174099",
      eventDefinitionId: "ed_signed_up",
      eventDefinitionVersionId: "edv_1",
    });
  });
});

function boundedAmountVersion() {
  return {
    fields: [
      {
        name: "amount",
        type: "number",
        required: true,
        numberKind: "amount",
        minimum: 10,
        maximum: 100,
      },
    ],
    dimensions: [],
  };
}

function purchaseLimitVersion() {
  return {
    fields: [
      {
        name: "internal_purchase_limit",
        type: "boolean",
        required: true,
      },
      {
        name: "profile",
        type: "json",
        required: true,
        jsonSchema: {
          type: "object",
          properties: {
            internal_quota: { type: "boolean" },
          },
          required: ["internal_quota"],
          additionalProperties: false,
        },
      },
    ],
    dimensions: [],
  };
}
