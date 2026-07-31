import { flagConfigKey } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  NOW,
  patchFlagConfig,
  startSeededExperiment,
  token,
} from "../src/config-store-harness-core";
import { makePoolHarness as makeHarness } from "./config-store-pool-harness";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
  // This suite is entirely about what a RUNNING Experiment shows on the read.
  await startSeededExperiment(h.d1);
});

afterEach(async () => {
  await h.dispose();
});

/**
 * The Flag Configuration read carries the RUNNING Experiment that owns part of it,
 * so a consumer can render the "Controlled by Experiment X" lock from the same read
 * that produced the configuration it is locking. A second lookup could disagree.
 */
describe("Flag Configuration controlling Experiment", () => {
  it("names the running Experiment that owns the Flag in this Environment", async () => {
    const body = await readConfig(ids.environmentId);

    expect(body.experiment).toEqual({ id: ids.experimentId, name: "Checkout experiment" });
  });

  it("tells the reader there is no Experiment rather than omitting the field", async () => {
    // Same Flag, different Environment: the Experiment lives in prod only, and the
    // Environment grain must not leak its lock into dev.
    const body = await readConfig(ids.devEnvironmentId);

    expect(body.experiment).toBeNull();
    expect("experiment" in body).toBe(true);
  });

  for (const status of ["draft", "ended"] as const) {
    it(`does not report a ${status} Experiment as controlling the Flag`, async () => {
      await setExperimentStatus(status);

      expect((await readConfig(ids.environmentId)).experiment).toBeNull();
    });
  }

  it("answers from D1 when a cached Configuration still points at a finished Experiment", async () => {
    // The KV blob is a read replica whose experiment pointer is synced after the D1
    // commit, so it can lag. The lock has to match what the write path will actually
    // refuse, which is D1 — and a lagging replica must never wedge the read.
    await setExperimentStatus("ended");
    await h.kv.put(
      flagConfigKey(ids.appId, ids.environmentId, ids.flagKey),
      JSON.stringify(await staleEnvelopeWithExperimentPointer()),
    );

    const body = await readConfig(ids.environmentId);

    expect(body.experiment).toBeNull();
    expect(body.flagId).toBe(ids.flagId);
  });

  /**
   * The kill switch, because it is the only field group a live Run leaves writable
   * — availability and Targeting are refused with `RUN_FROZEN`. The point stands
   * either way: the lock a write returns is the lock the next read reports.
   */
  it("keeps the lock aligned with the configuration a write returns", async () => {
    const res = await patchFlagConfig(h, { enabled: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      approvalRequest: null,
      config: {
        enabled: true,
        experiment: { id: ids.experimentId, name: "Checkout experiment" },
      },
    });
  });
});

async function readConfig(environmentId: string): Promise<Record<string, unknown>> {
  const jwt = await token(h.signer);
  const res = await h.app.request(
    `/apps/${ids.appId}/envs/${environmentId}/flags/${ids.flagId}/config`,
    { headers: { authorization: `Bearer ${jwt}` } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function setExperimentStatus(status: "draft" | "ended"): Promise<void> {
  const scope = envScope(ids.appId, ids.environmentId);
  const current = await h.repo.experiments.getExperiment(scope, ids.experimentId);
  if (!current) throw new Error("setExperimentStatus: Experiment not found");
  await h.repo.experiments.updateExperiment(
    scope,
    ids.experimentId,
    { status, liveRunId: null, updatedAt: NOW },
    current.liveRunId,
  );
}

/**
 * A KV envelope built from live D1 truth, then hand-edited to keep the Experiment
 * pointer a finished Experiment left behind.
 */
async function staleEnvelopeWithExperimentPointer(): Promise<unknown> {
  const key = flagConfigKey(ids.appId, ids.environmentId, ids.flagKey);
  await readConfig(ids.environmentId);
  const raw = await h.kv.get(key, "text");
  if (!raw) throw new Error("expected the read to have populated the KV replica");
  const envelope = JSON.parse(raw) as { data: { experimentId: string | null } };
  envelope.data.experimentId = ids.experimentId;
  return envelope;
}
