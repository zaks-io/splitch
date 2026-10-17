import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  activationConfigKey,
  CURRENT_KV_SCHEMA_VERSION,
  controlPlaneFlagConfigKey,
  experimentConfigKey,
  flagConfigKey,
  liveRunKey,
  runConfigKey,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { expect, it } from "vitest";
import { ids, kvJson, startSeededExperiment } from "../src/config-store-harness-core";
import { makeDurableConfigStoreProjectionJournal } from "../src/config-store-projection-journal";
import { makePoolHarness } from "./config-store-pool-harness";

it("keeps permanent Flag deletion's public tombstone TTL and unrelated Activation bindings", async () => {
  const h = await makePoolHarness();
  const identity = { appId: ids.appId, environmentId: ids.environmentId, flagId: ids.flagId };
  const stub = env.CONFIG_STORE_WRITER.getByName(`${ids.appId}:${ids.environmentId}`);
  await startSeededExperiment(h.d1);
  expect(
    await stub.syncExperimentConfig({ ...identity, experimentId: ids.experimentId }),
  ).toMatchObject({ ok: true });
  const activationKey = activationConfigKey(ids.appId, ids.environmentId);
  const unrelated = {
    eventDefinitionId: "event_unrelated",
    experimentId: "exp_unrelated",
    runId: "run_unrelated",
    idType: "user",
  };
  await h.kv.put(
    activationKey,
    JSON.stringify({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: {
        bindings: [
          unrelated,
          { ...unrelated, experimentId: ids.experimentId, runId: ids.liveRunId },
        ],
      },
    }),
  );
  await h.d1
    .prepare("UPDATE experiments SET status = 'archived', live_run_id = NULL WHERE id = ?")
    .bind(ids.experimentId)
    .run();
  const captured = await stub.readFlagConfigPurgeTarget(identity);
  if (!captured.ok) throw new Error("expected a purge target");
  await h.repo.flags.removeFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);

  const before = Math.floor(Date.now() / 1_000);
  expect(
    await stub.deleteFlagConfig({ ...identity, experimentIds: captured.experimentIds }),
  ).toMatchObject({ ok: true, snapshotRevision: 2 });
  const snapshotKey = controlPlaneFlagConfigKey(ids.appId, ids.environmentId, ids.flagId);
  expect(await kvJson(h.kv, snapshotKey)).toMatchObject({
    state: "deleted",
    revision: 2,
  });
  const tombstone = (await h.kv.list({ prefix: snapshotKey })).keys.find(
    (key) => key.name === snapshotKey,
  );
  expect(tombstone?.expiration).toBeGreaterThanOrEqual(before + 62);
  expect(tombstone?.expiration).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 62);
  for (const key of [
    flagConfigKey(ids.appId, ids.environmentId, ids.flagKey),
    experimentConfigKey(ids.appId, ids.environmentId, ids.experimentId),
    liveRunKey(ids.appId, ids.environmentId, ids.experimentId),
  ])
    expect(await h.kv.get(key)).toBeNull();
  expect(await h.kv.get(runConfigKey(ids.appId, ids.environmentId, ids.liveRunId))).not.toBeNull();
  expect(await kvJson(h.kv, activationKey)).toMatchObject({
    data: { bindings: [unrelated] },
  });
  expect(
    await h.repo.identity.getEnvironment(appScope(ids.appId), ids.environmentId),
  ).toMatchObject({ expiresAt: null });
  await evictDurableObject(stub);
  const retained = await runInDurableObject(stub, async (_instance, ctx) =>
    makeDurableConfigStoreProjectionJournal(ctx.storage).list(),
  );
  expect(retained).toContain(snapshotKey);
  expect(retained).toContain(activationKey);
});
