/**
 * Snapshot deletion is a two-step protocol -- `readFlagConfigPurgeTarget`
 * captures what a Flag owns from D1, then `deleteFlagConfig` unlinks exactly
 * that set -- so its cases are grouped here, away from the write path they
 * would otherwise be interleaved with.
 */
import {
  controlPlaneFlagConfigKey,
  experimentConfigKey,
  flagConfigKey,
  liveRunKey,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import {
  makeSnapshotRevisionCounter,
  narrowSeededAvailability,
  startSeededExperiment,
} from "../src/config-store-fixture-data";
import { type Harness, ids, kvJson, NOW, NOW_MS } from "../src/config-store-harness-core";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
  await narrowSeededAvailability(h.d1);
});

afterEach(async () => {
  await h.dispose();
});

describe("config store snapshot deletion", () => {
  it("deleteFlagConfig removes an archived Experiment's evaluation snapshots", async () => {
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: (nudge) => void h.nudges.push(nudge) },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      now: () => new Date(NOW_MS),
    });
    await store.resyncFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    await startSeededExperiment(h.d1);
    await store.syncExperimentConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentId: ids.experimentId,
    });
    const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);
    const controlPlaneKey = controlPlaneFlagConfigKey(ids.appId, ids.environmentId, ids.flagId);
    const experimentKey = experimentConfigKey(ids.appId, ids.environmentId, ids.experimentId);
    const liveKey = liveRunKey(ids.appId, ids.environmentId, ids.experimentId);
    expect(await h.kv.get(key, "text")).toEqual(expect.any(String));
    expect(await h.kv.get(controlPlaneKey, "text")).toEqual(expect.any(String));
    expect(await h.kv.get(experimentKey, "text")).toEqual(expect.any(String));
    expect(await h.kv.get(liveKey, "text")).toEqual(expect.any(String));
    await h.d1
      .prepare("UPDATE experiments SET status = 'archived', live_run_id = NULL WHERE id = ?")
      .bind(ids.experimentId)
      .run();
    expect(
      await h.repo.experiments.findRunningExperimentForFlag(
        envScope(ids.appId, ids.environmentId),
        ids.flagId,
      ),
    ).toBeNull();
    const captured = await store.readFlagConfigPurgeTarget({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    expect(captured).toMatchObject({
      ok: true,
      experimentIds: [ids.experimentId],
    });
    if (!captured.ok) throw new Error("expected the stored Flag Configuration");
    await h.repo.flags.removeFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId);

    const result = await store.deleteFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentIds: captured.experimentIds,
      flagId: ids.flagId,
    });
    expect(result.ok).toBe(true);
    expect(await h.kv.get(key, "text")).toBeNull();
    expect(await h.kv.get(experimentKey, "text")).toBeNull();
    expect(await h.kv.get(liveKey, "text")).toBeNull();
    expect(await kvJson(h.kv, controlPlaneKey)).toMatchObject({ state: "deleted", revision: 3 });
    expect(h.nudges).toContainEqual(
      expect.objectContaining({
        type: "config.changed",
        entity: "flag",
        id: ids.flagId,
        version: 0,
        deleted: true,
      }),
    );

    const retry = await store.deleteFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentIds: [],
      flagId: ids.flagId,
      flagKey: ids.flagKey,
    });
    expect(retry.ok).toBe(true);
  });
});

describe("config store purge target isolation", () => {
  it.each([
    "draft",
    "ended",
    "archived",
  ] as const)("captures an Experiment with %s status from D1", async (status) => {
    await h.d1
      .prepare("UPDATE experiments SET status = ?, live_run_id = NULL WHERE id = ?")
      .bind(status, ids.experimentId)
      .run();
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: (nudge) => void h.nudges.push(nudge) },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      now: () => new Date(NOW_MS),
    });

    await expect(
      store.readFlagConfigPurgeTarget({
        appId: ids.appId,
        environmentId: ids.environmentId,
        flagId: ids.flagId,
      }),
    ).resolves.toMatchObject({ ok: true, experimentIds: [ids.experimentId] });
  });

  it("does not capture another Flag's Experiment snapshots for deletion", async () => {
    const otherFlagId = "flag_unrelated_experiment";
    const otherExperimentId = "exp_unrelated_flag";
    const scope = envScope(ids.appId, ids.environmentId);
    await h.repo.flags.flags.insert(appScope(ids.appId), {
      id: otherFlagId,
      appId: ids.appId,
      key: "unrelated-flag",
      name: "Unrelated flag",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await h.repo.experiments.experiments.insert(scope, {
      id: otherExperimentId,
      appId: ids.appId,
      environmentId: ids.environmentId,
      key: "unrelated-experiment",
      flagId: otherFlagId,
      name: "Unrelated experiment",
      status: "archived",
      targetingKeyField: "userId",
      targetingKeyType: "user",
      metrics: "[]",
      guardrailMetrics: "[]",
      dimensions: "[]",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const unrelatedExperimentKey = experimentConfigKey(
      ids.appId,
      ids.environmentId,
      otherExperimentId,
    );
    const unrelatedLiveKey = liveRunKey(ids.appId, ids.environmentId, otherExperimentId);
    await h.kv.put(unrelatedExperimentKey, "unrelated experiment snapshot");
    await h.kv.put(unrelatedLiveKey, "unrelated live Run snapshot");
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: (nudge) => void h.nudges.push(nudge) },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
      now: () => new Date(NOW_MS),
    });

    const captured = await store.readFlagConfigPurgeTarget({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
    });
    expect(captured).toMatchObject({ ok: true, experimentIds: [ids.experimentId] });
    if (!captured.ok) throw new Error("expected a purge target");
    await h.repo.flags.removeFlagConfig(scope, ids.flagId);
    await store.deleteFlagConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      flagId: ids.flagId,
      experimentIds: captured.experimentIds,
    });

    expect(await h.kv.get(unrelatedExperimentKey, "text")).toBe("unrelated experiment snapshot");
    expect(await h.kv.get(unrelatedLiveKey, "text")).toBe("unrelated live Run snapshot");
  });
});
