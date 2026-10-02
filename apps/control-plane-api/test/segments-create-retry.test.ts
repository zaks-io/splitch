import { getRoute } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("segments_create repeated calls", () => {
  it("persists a distinct Segment on each identical create without an idempotency key", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);
    const body = {
      name: "Paid plan",
      conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
    };

    const first = await request(h, "POST", `/apps/${appId}/segments`, jwt, body);
    const second = await request(h, "POST", `/apps/${appId}/segments`, jwt, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(firstBody.id).not.toEqual(secondBody.id);

    const listed = await request(h, "GET", `/apps/${appId}/segments`, jwt);
    expect(listed.status).toBe(200);
    const items = ((await listed.json()) as { items: Array<{ id: string }> }).items;
    expect(items.map((item) => item.id).sort()).toEqual([firstBody.id, secondBody.id].sort());
    expect(getRoute("segments_create")?.effects.idempotent).toBe(false);
  });
});
