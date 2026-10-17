import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { controlPlaneFlagConfigKey, flagConfigKey } from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { expect, it } from "vitest";
import { durableConfigStoreAccess } from "../src/config-store-access";
import { ids } from "../src/config-store-harness-core";
import { makeDurableConfigStoreProjectionJournal } from "../src/config-store-projection-journal";
import { createTemporaryEnvironment } from "../src/temporary-environment-create";
import { makePoolHarness } from "./config-store-pool-harness";

it("journals the first create-time Sync through the production create and Durable Object copy path", async () => {
  const h = await makePoolHarness();
  const access = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, h.kv);
  const app = await h.repo.identity.getApp(ids.appId);
  if (!app) throw new Error("missing App fixture");
  let firstSyncObserved = false;
  const response = await createTemporaryEnvironment(
    {
      repo: h.repo,
      credentialStore: env.CREDENTIAL_STORE,
      exposureStatusCleanup: { delete: async () => {} },
      configStore: {
        ...access,
        writerFor(appId, environmentId) {
          const writer = access.writerFor(appId, environmentId);
          return {
            ...writer,
            async syncFlagConfig(input) {
              expect(firstSyncObserved).toBe(false);
              firstSyncObserved = true;
              expect(
                await h.repo.identity.getEnvironment(appScope(appId), environmentId),
              ).toMatchObject({ syncedFromEnvironmentId: ids.devEnvironmentId });
              expect(
                await h.repo.flags.getFlagConfig(envScope(appId, environmentId), ids.flagId),
              ).toBeNull();
              expect(
                await h.kv.get(controlPlaneFlagConfigKey(appId, environmentId, ids.flagId)),
              ).toBeNull();
              const stub = env.CONFIG_STORE_WRITER.getByName(`${appId}:${environmentId}`);
              expect(
                await runInDurableObject(
                  stub,
                  async (_instance, ctx) => (await ctx.storage.list()).size,
                ),
              ).toBe(0);
              return writer.syncFlagConfig(input);
            },
          };
        },
      },
    },
    app,
    { key: "first-sync-journal", temporary: { fromEnvironmentId: ids.devEnvironmentId } },
    {
      kind: "control-plane-token",
      id: "user_create_journal",
      appId: ids.appId,
      orgId: ids.orgId,
      environmentId: null,
      scopes: [`app:${ids.appId}:owner`],
      authDoor: "device_flow",
    },
    "req_create_journal",
  );
  expect(response.status).toBe(200);
  expect(firstSyncObserved).toBe(true);
  const created = (await response.json()) as { id: string };
  const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${created.id}`);
  const expected = [
    controlPlaneFlagConfigKey(ids.appId, created.id, ids.flagId),
    flagConfigKey(ids.appId, created.id, ids.flagKey),
  ];
  for (const key of expected) expect(await h.kv.get(key)).not.toBeNull();
  await evictDurableObject(stub);
  const recorded = await runInDurableObject(stub, async (_instance, ctx) =>
    makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
  );
  expect(recorded.toSorted()).toEqual(expected.toSorted());
});
