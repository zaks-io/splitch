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

const LIVE_EVENT_DEFINITION_ID = "event_definition_generation";
const PRIOR_EVENT_DEFINITION_ID = "event_definition_checkout";

async function seedActivationMetric(metricId: string, eventDefinitionId: string, key: string) {
  await h.repo.experiments.metrics.insert(appScope(ids.appId), {
    id: metricId,
    appId: ids.appId,
    key,
    name: key,
    kind: "count",
    eventDefinitionId,
    createdAt: NOW,
  });
}

async function freezeActivationMetric(runId: string, metricId: string) {
  await h.d1
    .prepare("UPDATE runs SET activation_metric_id = ? WHERE app_id = ? AND id = ?")
    .bind(metricId, ids.appId, runId)
    .run();
}

function makeStore() {
  return makeConfigStore({
    repo: h.repo,
    kv: h.kv,
    broadcaster: { broadcast: () => undefined },
    nextSnapshotRevision: makeSnapshotRevisionCounter(),
  });
}

function syncSeededExperiment(store: ReturnType<typeof makeStore>) {
  return store.syncExperimentConfig({
    appId: ids.appId,
    environmentId: ids.environmentId,
    experimentId: ids.experimentId,
  });
}

describe("config store Activation bindings", () => {
  it("publishes the Metric each Run froze, not just the live Run's", async () => {
    await seedActivationMetric("metric_activation", LIVE_EVENT_DEFINITION_ID, "generation");
    await seedActivationMetric("metric_activation_prior", PRIOR_EVENT_DEFINITION_ID, "checkout");
    await freezeActivationMetric(ids.liveRunId, "metric_activation");
    await freezeActivationMetric(ids.newerRunId, "metric_activation_prior");
    await startSeededExperiment(h.d1);

    await syncSeededExperiment(makeStore());

    expect(await kvJson(h.kv, activationConfigKey(ids.appId, ids.environmentId))).toMatchObject({
      data: {
        bindings: [
          {
            eventDefinitionId: LIVE_EVENT_DEFINITION_ID,
            experimentId: ids.experimentId,
            runId: ids.liveRunId,
            idType: "user",
          },
          {
            eventDefinitionId: PRIOR_EVENT_DEFINITION_ID,
            experimentId: ids.experimentId,
            runId: ids.newerRunId,
            idType: "user",
          },
        ],
      },
    });
  });

  it("keeps an ended Run's binding so its holdover Entities still activate", async () => {
    await seedActivationMetric("metric_activation", LIVE_EVENT_DEFINITION_ID, "generation");
    await freezeActivationMetric(ids.liveRunId, "metric_activation");
    await startSeededExperiment(h.d1);
    const store = makeStore();
    await syncSeededExperiment(store);

    await h.d1
      .prepare("UPDATE experiments SET status = 'ended', live_run_id = NULL WHERE id = ?")
      .bind(ids.experimentId)
      .run();
    await syncSeededExperiment(store);

    // Ending a Run does not end its measurement: Entities first exposed under it
    // keep their Variant and keep converting into it (ADR-0006), and ingest can
    // only attribute those Activations while this binding is still published.
    expect(await kvJson(h.kv, activationConfigKey(ids.appId, ids.environmentId))).toMatchObject({
      data: {
        bindings: [
          {
            eventDefinitionId: LIVE_EVENT_DEFINITION_ID,
            experimentId: ids.experimentId,
            runId: ids.liveRunId,
            idType: "user",
          },
        ],
      },
    });
  });

  // Deleting a Metric is allowed once no Run is running, and the ended Run keeps
  // pointing at it. Resolving that Run must not throw: buildSnapshot feeds every
  // flag-config read and write for this Flag, so a throw here would wedge them all
  // with no API path back.
  it("skips a Run whose frozen activation Metric was deleted", async () => {
    await seedActivationMetric("metric_activation", LIVE_EVENT_DEFINITION_ID, "generation");
    await freezeActivationMetric(ids.liveRunId, "metric_activation");
    await startSeededExperiment(h.d1);
    const store = makeStore();
    await syncSeededExperiment(store);

    await h.d1
      .prepare("UPDATE experiments SET status = 'ended', live_run_id = NULL WHERE id = ?")
      .bind(ids.experimentId)
      .run();
    await h.d1
      .prepare("DELETE FROM metrics WHERE app_id = ? AND id = ?")
      .bind(ids.appId, "metric_activation")
      .run();

    await expect(syncSeededExperiment(store)).resolves.toBeDefined();
    expect(await kvJson(h.kv, activationConfigKey(ids.appId, ids.environmentId))).toMatchObject({
      data: { bindings: [] },
    });
  });

  it("publishes nothing when no Run froze an activation Metric", async () => {
    await startSeededExperiment(h.d1);

    await syncSeededExperiment(makeStore());

    expect(await kvJson(h.kv, activationConfigKey(ids.appId, ids.environmentId))).toMatchObject({
      data: { bindings: [] },
    });
  });
});
