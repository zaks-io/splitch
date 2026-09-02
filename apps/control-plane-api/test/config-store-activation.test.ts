import { activationConfigKey } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConfigStore } from "../src/config-store";
import {
  makeSnapshotRevisionCounter,
  startSeededExperiment,
} from "../src/config-store-fixture-data";
import { type Harness, ids, kvJson, NOW } from "../src/config-store-harness-core";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("config store Activation bindings", () => {
  it("publishes and removes the frozen live-Run binding", async () => {
    const metricId = "metric_activation";
    const eventDefinitionId = "event_definition_generation";
    await h.repo.experiments.metrics.insert(appScope(ids.appId), {
      id: metricId,
      appId: ids.appId,
      key: "generation",
      name: "Generation",
      kind: "count",
      eventDefinitionId,
      createdAt: NOW,
    });
    await h.d1
      .prepare("UPDATE runs SET activation_metric_id = ? WHERE app_id = ? AND id = ?")
      .bind(metricId, ids.appId, ids.liveRunId)
      .run();
    await startSeededExperiment(h.d1);
    const store = makeConfigStore({
      repo: h.repo,
      kv: h.kv,
      broadcaster: { broadcast: () => undefined },
      nextSnapshotRevision: makeSnapshotRevisionCounter(),
    });

    await store.syncExperimentConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentId: ids.experimentId,
    });

    const key = activationConfigKey(ids.appId, ids.environmentId);
    expect(await kvJson(h.kv, key)).toMatchObject({
      data: {
        bindings: [
          {
            eventDefinitionId,
            experimentId: ids.experimentId,
            runId: ids.liveRunId,
            idType: "user",
          },
        ],
      },
    });

    await h.d1
      .prepare("UPDATE experiments SET status = 'ended', live_run_id = NULL WHERE id = ?")
      .bind(ids.experimentId)
      .run();
    await store.syncExperimentConfig({
      appId: ids.appId,
      environmentId: ids.environmentId,
      experimentId: ids.experimentId,
    });

    expect(await kvJson(h.kv, key)).toMatchObject({ data: { bindings: [] } });
  });
});
