import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("hydrated Flag list query count", () => {
  it("stays at seven D1 queries for both (N=1, E=2) and (N=4, E=3)", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const first = await createFlag(h, createdApp.app.id, jwt);
    const counted = countQueries(h.bindings.d1);
    const countedApp = makeAppForRepo(h, createRepository(counted.d1));

    const small = await countedList(countedApp, createdApp.app.id, jwt, counted);
    expect(small).toEqual({ items: 1, queries: 7 });

    const repo = createRepository(h.bindings.d1);
    const qaEnvironmentId = "env_hydration_qa";
    await repo.identity.environments.insert(appScope(createdApp.app.id), {
      id: qaEnvironmentId,
      appId: createdApp.app.id,
      key: "qa",
      name: "QA",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await repo.flags.flagConfigs.insert(envScope(createdApp.app.id, qaEnvironmentId), {
      id: "cfg_hydration_qa_first",
      appId: createdApp.app.id,
      environmentId: qaEnvironmentId,
      flagId: first.id,
      enabled: false,
      availableVariantNames: "[]",
      defaultVariantId: first.defaultVariantId,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    for (let index = 1; index < 4; index += 1) {
      await createFlag(h, createdApp.app.id, jwt, {
        ...baseFlag(createdApp.app.id),
        key: `hydrated-query-count-${index}`,
        name: `Hydrated query count ${index}`,
      });
    }

    const large = await countedList(countedApp, createdApp.app.id, jwt, counted);
    expect(large).toEqual({ items: 4, queries: 7 });
  });
});

async function countedList(
  app: FlagDefinitionHarness["app"],
  appId: string,
  jwt: string,
  counted: ReturnType<typeof countQueries>,
) {
  counted.reset();
  const response = await app.request(`/apps/${appId}/flags?include=config`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { items: unknown[] };
  return { items: body.items.length, queries: counted.count() };
}

function countQueries(d1: D1Database) {
  let prepared = 0;
  return {
    d1: new Proxy(d1, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            prepared += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    count: () => prepared,
    reset: () => {
      prepared = 0;
    },
  };
}
