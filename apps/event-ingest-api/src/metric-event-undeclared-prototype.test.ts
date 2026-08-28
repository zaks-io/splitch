import { describe, expect, it } from "vitest";
import { METRIC_EVENT_NAME } from "./metric-event.test-fixture";
import {
  EMPTY_DECLARATION,
  expectNoDefinitionIds,
  ingestPrototypeMetricEvent,
  mismatchIssues,
  ownJson,
  PROTOTYPE_NAMES,
} from "./metric-event-prototype-helpers";

describe("undeclared prototype-name Metric Event keys", () => {
  it.each(
    PROTOTYPE_NAMES,
  )("Client Key rejects undeclared root %s and never admits it", async (name) => {
    const { response, parsed } = await ingestPrototypeMetricEvent(
      EMPTY_DECLARATION,
      { fields: ownJson(name, true), dimensions: {} },
      "client_key",
    );
    expect(response.status).toBe(400);
    expect(response.status).not.toBe(202);
    if (name === "__proto__") {
      expect(parsed.code).toBe("VALIDATION_ERROR");
      expectNoDefinitionIds(parsed);
      return;
    }
    expect(parsed).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["fields", name], message: "fields key is not declared" }],
      },
    });
    expectNoDefinitionIds(parsed);
  });

  it.each(PROTOTYPE_NAMES)("HTTP trusted: undeclared root %s is not admitted", async (name) => {
    const { response, parsed } = await ingestPrototypeMetricEvent(EMPTY_DECLARATION, {
      fields: ownJson(name, true),
      dimensions: {},
    });
    expect(response.status).not.toBe(202);
    if (name === "__proto__") {
      expect(parsed.code).toBe("VALIDATION_ERROR");
      return;
    }
    expect(mismatchIssues(parsed)).toContainEqual({
      path: ["fields", name],
      message: "fields key is not declared",
    });
  });

  it.each(
    PROTOTYPE_NAMES,
  )("Client Key rejects undeclared root dimension %s and never admits it", async (name) => {
    const { response, parsed } = await ingestPrototypeMetricEvent(
      EMPTY_DECLARATION,
      { fields: {}, dimensions: ownJson(name, true) },
      "client_key",
    );
    expect(response.status).toBe(400);
    expect(response.status).not.toBe(202);
    if (name === "__proto__") {
      expect(parsed.code).toBe("VALIDATION_ERROR");
      expectNoDefinitionIds(parsed);
      return;
    }
    expect(parsed).toEqual({
      code: "EVENT_SCHEMA_MISMATCH",
      message: "Metric Event does not match the Event Definition Version",
      details: {
        eventName: METRIC_EVENT_NAME,
        issues: [{ path: ["dimensions", name], message: "dimensions key is not declared" }],
      },
    });
    expectNoDefinitionIds(parsed);
  });
});
