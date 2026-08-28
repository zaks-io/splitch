import { eventDefinitionConfigKey, ErrorResponseSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  hotConfig,
  METRIC_APP_ID,
  METRIC_EVENT_NAME,
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";

const ownConstructorTrue = JSON.parse('{"constructor":true}') as { constructor: boolean };

const ROOT_CONSTRUCTOR = {
  fields: [{ name: "constructor", type: "boolean" as const, required: true }],
  dimensions: [],
};

const NESTED_REQUIRED_CONSTRUCTOR = {
  fields: [
    {
      name: "profile",
      type: "json" as const,
      required: true,
      jsonSchema: {
        type: "object" as const,
        properties: { constructor: { type: "boolean" as const } },
        required: ["constructor"],
        additionalProperties: false as const,
      },
    },
  ],
  dimensions: [],
};

const CLOSED_EMPTY_OBJECT = {
  fields: [
    {
      name: "profile",
      type: "json" as const,
      required: true,
      jsonSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
    },
  ],
  dimensions: [],
};

async function ingestWith(
  version: Record<string, unknown>,
  body: Record<string, unknown>,
  credentialKind: "api_key" | "client_key" = "api_key",
) {
  const fixture = await makeMetricEventFixture({}, credentialKind);
  fixture.config.set(
    eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
    hotConfig("edv_1", 1, version),
  );
  const response = await sendMetricEvent(fixture, metricEventBody(body));
  const parsed = ErrorResponseSchema.parse(await response.json());
  return { response, parsed };
}

function mismatchIssues(body: ReturnType<typeof ErrorResponseSchema.parse>) {
  expect(body.code).toBe("EVENT_SCHEMA_MISMATCH");
  if (body.code !== "EVENT_SCHEMA_MISMATCH") throw new Error("expected EVENT_SCHEMA_MISMATCH");
  return body.details.issues;
}

describe("metric event own-property validation", () => {
  it("rejects an absent required root constructor as missing, not expected boolean", async () => {
    const { response, parsed } = await ingestWith(ROOT_CONSTRUCTOR, { fields: {}, dimensions: {} });
    expect(response.status).not.toBe(202);
    expect(mismatchIssues(parsed)).toContainEqual({
      path: ["fields", "constructor"],
      message: "required value is missing",
    });
    expect(JSON.stringify(parsed)).not.toContain("expected boolean");
  });

  it("rejects an absent required nested constructor as missing, not expected boolean", async () => {
    const { response, parsed } = await ingestWith(NESTED_REQUIRED_CONSTRUCTOR, {
      fields: { profile: {} },
      dimensions: {},
    });
    expect(response.status).not.toBe(202);
    expect(mismatchIssues(parsed)).toContainEqual({
      path: ["fields", "profile", "constructor"],
      message: "required JSON key is missing",
    });
    expect(JSON.stringify(parsed)).not.toContain("expected boolean");
  });

  it("rejects an own nested constructor against a closed empty JSON schema", async () => {
    const { response, parsed } = await ingestWith(CLOSED_EMPTY_OBJECT, {
      fields: { profile: ownConstructorTrue },
      dimensions: {},
    });
    expect(response.status).not.toBe(202);
    expect(mismatchIssues(parsed)).toContainEqual({
      path: ["fields", "profile", "constructor"],
      message: "JSON key is not declared",
    });
  });

  it("Client Key rejects the closed-schema constructor field and stays generic", async () => {
    const { response, parsed } = await ingestWith(
      CLOSED_EMPTY_OBJECT,
      { fields: { profile: ownConstructorTrue }, dimensions: {} },
      "client_key",
    );
    expect(response.status).toBe(400);
    expect(parsed).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [
          { path: ["fields", "profile", "constructor"], message: "JSON key is not declared" },
        ],
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("ed_signed_up");
    expect(JSON.stringify(parsed)).not.toContain("edv_1");
  });
});
