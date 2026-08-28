import type {
  ClosedJson,
  EventDefinitionVersion,
  MetricEventTrackRequest,
} from "@splitch/contracts";
import { eventDefinitionConfigKey, ErrorResponseSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { validateMetricEvent } from "./metric-event-validation";
import {
  hotConfig,
  METRIC_APP_ID,
  METRIC_EVENT_NAME,
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";

const PROTOTYPE_NAMES = ["constructor", "toString", "__proto__"] as const;

function ownJson(key: string, value: unknown): Record<string, unknown> {
  return JSON.parse(`{${JSON.stringify(key)}:${JSON.stringify(value)}}`) as Record<string, unknown>;
}

function rootRequired(name: string) {
  return { fields: [{ name, type: "boolean" as const, required: true }], dimensions: [] };
}

function nestedJsonSchema(name: string): ClosedJson {
  return {
    type: "object",
    properties: ownJson(name, { type: "boolean" }) as Record<string, ClosedJson>,
    required: [name],
    additionalProperties: false,
  };
}

function nestedRequired(name: string) {
  return {
    fields: [
      {
        name: "profile",
        type: "json" as const,
        required: true,
        jsonSchema: nestedJsonSchema(name),
      },
    ],
    dimensions: [],
  };
}

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

const UNIT_EVENT: MetricEventTrackRequest = {
  eventName: METRIC_EVENT_NAME,
  targetingKey: "entity-7",
  idType: "user",
  eventId: "123e4567-e89b-42d3-a456-426614174000",
  fields: {},
  dimensions: {},
};

function unitVersion(fields: EventDefinitionVersion["fields"]): EventDefinitionVersion {
  return {
    id: "edv_1",
    eventDefinitionId: "ed_signed_up",
    version: 1,
    schemaHash: `sha256:${"a".repeat(64)}`,
    entityType: "user",
    fields,
    dimensions: [],
    publishedAt: "2026-08-07T00:00:00.000Z",
  };
}

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
  it.each(
    PROTOTYPE_NAMES,
  )("absent required root %s is missing, not an inherited boolean mismatch", (name) => {
    const issues = validateMetricEvent(
      UNIT_EVENT,
      unitVersion([{ name, type: "boolean", required: true }]),
    );
    expect(issues).toEqual([{ path: ["fields", name], message: "required value is missing" }]);
  });

  it.each(PROTOTYPE_NAMES)("absent required nested %s is missing, not inherited", (name) => {
    const issues = validateMetricEvent(
      { ...UNIT_EVENT, fields: { profile: {} } },
      unitVersion([
        {
          name: "profile",
          type: "json",
          required: true,
          jsonSchema: nestedJsonSchema(name),
        },
      ]),
    );
    expect(issues).toEqual([
      { path: ["fields", "profile", name], message: "required JSON key is missing" },
    ]);
  });

  it.each(
    PROTOTYPE_NAMES,
  )("own nested {%s: true} is rejected by a closed empty JSON schema", (name) => {
    const issues = validateMetricEvent(
      { ...UNIT_EVENT, fields: { profile: ownJson(name, true) } },
      unitVersion([
        {
          name: "profile",
          type: "json",
          required: true,
          jsonSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ]),
    );
    expect(issues).toEqual([
      { path: ["fields", "profile", name], message: "JSON key is not declared" },
    ]);
  });

  it.each(
    PROTOTYPE_NAMES,
  )("HTTP trusted: absent root %s is missing, not expected boolean", async (name) => {
    const { response, parsed } = await ingestWith(rootRequired(name), {
      fields: {},
      dimensions: {},
    });
    expect(response.status).not.toBe(202);
    expect(mismatchIssues(parsed)).toContainEqual({
      path: ["fields", name],
      message: "required value is missing",
    });
    expect(JSON.stringify(parsed)).not.toContain("expected boolean");
  });

  it.each(PROTOTYPE_NAMES)("HTTP trusted: absent nested %s is missing", async (name) => {
    const { response, parsed } = await ingestWith(nestedRequired(name), {
      fields: { profile: {} },
      dimensions: {},
    });
    expect(response.status).not.toBe(202);
    expect(mismatchIssues(parsed)).toContainEqual({
      path: ["fields", "profile", name],
      message: "required JSON key is missing",
    });
    expect(JSON.stringify(parsed)).not.toContain("expected boolean");
  });

  it.each(
    PROTOTYPE_NAMES,
  )("HTTP trusted: own nested %s is not admitted against properties: {}", async (name) => {
    const { response, parsed } = await ingestWith(CLOSED_EMPTY_OBJECT, {
      fields: { profile: ownJson(name, true) },
      dimensions: {},
    });
    expect(response.status).not.toBe(202);
    if (name === "__proto__") {
      expect(parsed.code).toBe("VALIDATION_ERROR");
      return;
    }
    expect(mismatchIssues(parsed)).toContainEqual({
      path: ["fields", "profile", name],
      message: "JSON key is not declared",
    });
  });

  it.each(
    PROTOTYPE_NAMES,
  )("Client Key does not leak an absent configured %s name or type", async (name) => {
    const { response, parsed } = await ingestWith(
      rootRequired(name),
      { fields: {}, dimensions: {} },
      "client_key",
    );
    expect(response.status).toBe(400);
    expect(parsed).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["fields"], message: "invalid value" }],
      },
    });
    expect(JSON.stringify(parsed)).not.toContain(name);
    expect(JSON.stringify(parsed)).not.toContain("expected ");
    expect(JSON.stringify(parsed)).not.toContain("ed_signed_up");
    expect(JSON.stringify(parsed)).not.toContain("edv_1");
  });

  it.each(
    PROTOTYPE_NAMES,
  )("Client Key rejects own nested %s against a closed schema without IDs", async (name) => {
    const { response, parsed } = await ingestWith(
      CLOSED_EMPTY_OBJECT,
      { fields: { profile: ownJson(name, true) }, dimensions: {} },
      "client_key",
    );
    expect(response.status).toBe(400);
    expect(response.status).not.toBe(202);
    if (name === "__proto__") {
      expect(parsed.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(parsed)).not.toContain("ed_signed_up");
      expect(JSON.stringify(parsed)).not.toContain("edv_1");
      return;
    }
    expect(parsed).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["fields", "profile", name], message: "JSON key is not declared" }],
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("ed_signed_up");
    expect(JSON.stringify(parsed)).not.toContain("edv_1");
  });
});
