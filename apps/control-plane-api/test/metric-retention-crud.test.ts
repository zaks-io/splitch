import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  errorBody,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { ensureMetricEventDefinition } from "./metric-event-definition-fixture";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("Retention Metric CRUD", () => {
  it("stores a horizon and refuses a Retention Metric without one", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);
    const eventDefinitionId = await ensureMetricEventDefinition(
      h.bindings.d1,
      appId,
      "returned",
      NOW_ISO,
    );

    const missing = await request(h, "POST", `/apps/${appId}/metrics`, jwt, {
      appId,
      name: "D7",
      key: "d7",
      kind: "retention",
      eventDefinitionId,
    });
    expect(missing.status).toBe(400);
    expect((await errorBody(missing)).code).toBe("VALIDATION_ERROR");

    const created = await request(h, "POST", `/apps/${appId}/metrics`, jwt, {
      appId,
      name: "D7",
      key: "d7",
      kind: "retention",
      eventDefinitionId,
      horizonStartMs: 0,
      horizonEndMs: 86_400_000,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      kind: "retention",
      horizonStartMs: 0,
      horizonEndMs: 86_400_000,
    });
  });
});
