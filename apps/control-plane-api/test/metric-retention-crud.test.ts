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
    const body = (await created.json()) as { id: string; kind: string };
    expect(body).toMatchObject({
      kind: "retention",
      horizonStartMs: 0,
      horizonEndMs: 86_400_000,
    });

    const read = await request(h, "GET", `/apps/${appId}/metrics/${body.id}`, jwt);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: body.id,
      kind: "retention",
      horizonStartMs: 0,
      horizonEndMs: 86_400_000,
    });
  });

  it.each([
    { key: "signup", kind: "binomial" as const },
    { key: "items", kind: "count" as const, eventFieldName: "quantity" },
    { key: "revenue", kind: "revenue" as const, eventFieldName: "amount" },
  ])("rejects horizon fields on a $kind Metric PATCH", async ({ key, kind, eventFieldName }) => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);
    const eventDefinitionId = await ensureMetricEventDefinition(
      h.bindings.d1,
      appId,
      key,
      NOW_ISO,
      eventFieldName,
    );
    const created = await request(h, "POST", `/apps/${appId}/metrics`, jwt, {
      appId,
      name: key,
      key,
      kind,
      eventDefinitionId,
      ...(eventFieldName ? { eventFieldName } : {}),
    });
    expect(created.status).toBe(200);
    const metric = (await created.json()) as { id: string };

    const patched = await request(h, "PATCH", `/apps/${appId}/metrics/${metric.id}`, jwt, {
      horizonStartMs: 0,
      horizonEndMs: 86_400_000,
    });
    expect(patched.status).toBe(400);
    expect((await errorBody(patched)).code).toBe("VALIDATION_ERROR");
  });

  it("rejects horizon fields on a ratio Metric PATCH", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);
    const numeratorId = await ensureMetricEventDefinition(h.bindings.d1, appId, "signup", NOW_ISO);
    const denominatorId = await ensureMetricEventDefinition(
      h.bindings.d1,
      appId,
      "session",
      NOW_ISO,
    );
    const numerator = await request(h, "POST", `/apps/${appId}/metrics`, jwt, {
      appId,
      name: "signup",
      key: "signup",
      kind: "binomial",
      eventDefinitionId: numeratorId,
    });
    const denominator = await request(h, "POST", `/apps/${appId}/metrics`, jwt, {
      appId,
      name: "session",
      key: "session",
      kind: "binomial",
      eventDefinitionId: denominatorId,
    });
    expect(numerator.status).toBe(200);
    expect(denominator.status).toBe(200);
    const ratio = await request(h, "POST", `/apps/${appId}/metrics`, jwt, {
      appId,
      name: "signup-rate",
      key: "signup-rate",
      kind: "ratio",
      numerator: { metricId: ((await numerator.json()) as { id: string }).id },
      denominator: { metricId: ((await denominator.json()) as { id: string }).id },
    });
    expect(ratio.status).toBe(200);
    const metric = (await ratio.json()) as { id: string };

    const patched = await request(h, "PATCH", `/apps/${appId}/metrics/${metric.id}`, jwt, {
      horizonStartMs: 0,
      horizonEndMs: 86_400_000,
    });
    expect(patched.status).toBe(400);
    expect((await errorBody(patched)).code).toBe("VALIDATION_ERROR");
  });
});
