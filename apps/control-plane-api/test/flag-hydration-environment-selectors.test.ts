import type { ErrorResponse, HydratedFlagResponse } from "@splitch/contracts";
import { appScope, createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("hydrated Flag Environment selectors", () => {
  it("resolves an Environment key to its canonical ID before hydration", async () => {
    const fixture = await flagFixture();
    const prod = requiredEnvironment(fixture.environments, "prod");

    const response = await request(
      h,
      "GET",
      `/apps/${fixture.appId}/flags/${fixture.flagId}?include=config&envs=prod`,
      fixture.jwt,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as HydratedFlagResponse;
    expect(body.configurations.map((configuration) => configuration.environmentId)).toEqual([
      prod.id,
    ]);
  });

  it("returns SELECTOR_AMBIGUOUS with candidates for an ambiguous envs selector", async () => {
    const fixture = await flagFixture();
    const prod = requiredEnvironment(fixture.environments, "prod");
    const collisionId = "env_hydration_selector_collision";
    const repo = createRepository(h.bindings.d1);
    await repo.identity.environments.insert(appScope(fixture.appId), {
      id: collisionId,
      appId: fixture.appId,
      key: prod.id,
      name: "Hydration selector collision",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });

    const response = await request(
      h,
      "GET",
      `/apps/${fixture.appId}/flags/${fixture.flagId}?include=config&envs=${prod.id}`,
      fixture.jwt,
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as ErrorResponse).toEqual({
      code: "SELECTOR_AMBIGUOUS",
      message: `Environment selector "${prod.id}" matches more than one Environment`,
      details: {
        recommendedAction: "USE_CANONICAL_ID",
        candidates: expect.arrayContaining([
          { environmentId: prod.id, environmentKey: "prod" },
          { environmentId: collisionId, environmentKey: prod.id },
        ]),
      },
    });
  });

  it("fails loud when an envs selector resolves to no Environment", async () => {
    const fixture = await flagFixture();
    const all = await request(
      h,
      "GET",
      `/apps/${fixture.appId}/flags/${fixture.flagId}?include=config`,
      fixture.jwt,
    );
    expect(all.status, await all.clone().text()).toBe(200);
    expect(((await all.json()) as HydratedFlagResponse).configurations).toHaveLength(2);

    const missing = await request(
      h,
      "GET",
      `/apps/${fixture.appId}/flags/${fixture.flagId}?include=config&envs=does-not-exist`,
      fixture.jwt,
    );

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "APP_NOT_FOUND" });
  });
});

async function flagFixture() {
  const created = await createDefaultApp(h);
  const jwt = await appToken(h, created.app.id);
  const flag = await createFlag(h, created.app.id, jwt);
  return {
    appId: created.app.id,
    environments: created.environments,
    flagId: flag.id,
    jwt,
  };
}

function requiredEnvironment(environments: Array<{ id: string; key: string }>, key: string) {
  const environment = environments.find((candidate) => candidate.key === key);
  if (!environment) throw new Error(`fixture App is missing ${key} Environment`);
  return environment;
}
